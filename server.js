const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const axios = require('axios'); // For Telegram Bot API calls

const app = express();
const port = 3000;

// MongoDB URI (replace with your MongoDB connection string)
const mongoURI = 'mongodb://localhost:27017/earningsApp';
mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.log('MongoDB connection error:', err));

// Telegram Bot Token (replace with your bot token from BotFather)
const telegramToken = 'YOUR_BOT_TOKEN';
const telegramAPI = `https://api.telegram.org/bot${telegramToken}/`;

// Define the User Schema with necessary fields
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String },
  balance: { type: Number, default: 0.0 },
  referralEarnings: { type: Number, default: 0.0 },
  referrals: [String], // List of referred user IDs
  referralCode: { type: String, unique: true },
  lastWithdrawal: { type: Date },
  dailyClaimTimeRemaining: { type: Number, default: 0 }, // In seconds
  lastClaimed: { type: Date },
  referralCommissionClaimed: { type: Boolean, default: false }, // Track if referral commission has been claimed
  lastAdClaimTime: { type: Date }, // Store the last time an ad was claimed
  adCooldownTimeRemaining: { type: Number, default: 0 }, // Cooldown time for the next ad claim (in seconds)
});

// Create a Model from the schema
const User = mongoose.model('User', userSchema);

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files (your frontend)
app.use(express.static('public'));

// API to get user data and balance
app.get('/api/user/:userId', async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    return res.json({
      balance: user.balance,
      referralEarnings: user.referralEarnings,
      referrals: user.referrals.length,
      lastWithdrawal: user.lastWithdrawal,
      dailyClaimTimeRemaining: user.dailyClaimTimeRemaining,
      referralCommissionClaimed: user.referralCommissionClaimed,
      adCooldownTimeRemaining: user.adCooldownTimeRemaining, // Add the ad cooldown info
    });
  } catch (err) {
    return res.status(500).json({ message: 'Error fetching user data', error: err });
  }
});

// API to register a new user (via Telegram Web App or Bot)
app.post('/api/register', async (req, res) => {
  try {
    const { userId, username, referralCode } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ userId });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Check if referral code is valid
    let referrer = null;
    if (referralCode) {
      referrer = await User.findOne({ referralCode });
      if (!referrer) {
        return res.status(400).json({ message: 'Invalid referral code' });
      }
    }

    // Generate unique referral code for the new user
    const referralCodeGenerated = Math.random().toString(36).substring(2, 10);

    // Create the new user
    const newUser = new User({
      userId,
      username,
      referralCode: referralCodeGenerated,
      referrals: referrer ? [referrer.userId] : [],
    });

    // Add referral earnings to the referrer if valid
    if (referrer) {
      referrer.referralEarnings += 0.005; // You can adjust the commission rate
      await referrer.save();
    }

    // Save the new user to the database
    await newUser.save();

    res.json({
      message: 'User registered successfully',
      referralCode: referralCodeGenerated,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Error registering user', error: err });
  }
});

// API to handle the claiming of rewards by watching ads
app.post('/api/claim/ad/:userId', async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const adEarnings = 0.005; // Earnings per ad watched
    const adCooldown = 60 * 60 * 2; // 2 hours cooldown for each ad claim

    // Check if the user can claim the ad
    const now = new Date();
    const lastAdClaimTime = user.lastAdClaimTime ? new Date(user.lastAdClaimTime) : null;
    const elapsedTime = lastAdClaimTime ? Math.floor((now - lastAdClaimTime) / 1000) : null;
    const remainingCooldown = adCooldown - (elapsedTime || 0);

    if (remainingCooldown > 0) {
      return res.status(400).json({ message: `Please wait ${remainingCooldown} seconds before claiming the ad again.` });
    }

    // Update the user's balance by adding earnings from watching ads
    user.balance += adEarnings;
    user.lastAdClaimTime = now; // Update last ad claim time
    user.adCooldownTimeRemaining = adCooldown; // Set cooldown time remaining
    await user.save();

    // Check if user has referrals to reward
    if (user.referrals.length > 0) {
      for (let refUserId of user.referrals) {
        const refUser = await User.findOne({ userId: refUserId });
        if (refUser) {
          // Add 5% of the referral earnings to the referrer's commission
          const referralCommission = refUser.referralEarnings * 0.05;
          user.referralEarnings += referralCommission;
          await user.save();
        }
      }
    }

    // Send Telegram notification to user
    await axios.post(`${telegramAPI}sendMessage`, {
      chat_id: user.userId,
      text: `You earned $${adEarnings.toFixed(3)} by watching an ad! Your new balance is $${user.balance.toFixed(3)}`
    });

    res.json({
      message: 'Ad claimed successfully',
      balance: user.balance.toFixed(3),
      referralEarnings: user.referralEarnings.toFixed(3),
      adCooldownTimeRemaining: user.adCooldownTimeRemaining,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Error claiming ad earnings', error: err });
  }
});

// API to handle the claiming of referral commissions
app.post('/api/claim/referralCommission/:userId', async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if user has any referral earnings
    if (user.referralEarnings <= 0) {
      return res.status(400).json({ message: 'No referral earnings available to claim' });
    }

    // Add referral earnings to user balance
    user.balance += user.referralEarnings;
    user.referralEarnings = 0; // Reset referral earnings after claiming
    user.referralCommissionClaimed = true; // Mark referral commission as claimed
    await user.save();

    // Send Telegram message to user
    await axios.post(`${telegramAPI}sendMessage`, {
      chat_id: user.userId,
      text: `You claimed your referral earnings of $${user.balance.toFixed(3)}! Your new balance is $${user.balance.toFixed(3)}.`
    });

    res.json({
      message: 'Referral earnings claimed successfully',
      balance: user.balance.toFixed(3)
    });
  } catch (err) {
    return res.status(500).json({ message: 'Error claiming referral earnings', error: err });
  }
});

// API to handle the claiming of daily reward
app.post('/api/claim/dailyReward/:userId', async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if the user can claim the daily reward
    const now = new Date();
    const elapsedTime = user.dailyClaimTimeRemaining ? (now.getTime() / 1000) - user.dailyClaimTimeRemaining : 0;
    const dailyCooldown = 86400; // 24 hours in seconds

    if (elapsedTime < dailyCooldown) {
      return res.status(400).json({ message: `You can claim your daily reward in ${Math.ceil(dailyCooldown - elapsedTime)} seconds.` });
    }

    // Add daily reward to user's balance
    user.balance += 0.003; // Reward for claiming daily
    user.dailyClaimTimeRemaining = now.getTime() / 1000; // Reset the cooldown timer

    await user.save();

    // Send Telegram notification
    await axios.post(`${telegramAPI}sendMessage`, {
      chat_id: user.userId,
      text: `You claimed your daily reward of $0.003! Your new balance is $${user.balance.toFixed(3)}`
    });

    res.json({
      message: 'Daily reward claimed successfully',
      balance: user.balance.toFixed(3),
    });
  } catch (err) {
    return res.status(500).json({ message: 'Error claiming daily reward', error: err });
  }
});

// API to handle withdrawals
app.post('/api/withdraw/:userId', async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const { amount } = req.body;
    if (amount < 3) {
      return res.status(400).json({ message: 'Minimum withdrawal amount is $3' });
    }
    if (user.balance < amount) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    // Process withdrawal
    user.balance -= amount;
    user.lastWithdrawal = new Date();
    await user.save();

    res.json({
      message: 'Withdrawal requested successfully',
      balance: user.balance.toFixed(3),
    });
  } catch (err) {
    return res.status(500).json({ message: 'Error processing withdrawal', error: err });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
