// routes/auth-google.js - Endpoint Google OAuth untuk Clipora
const express = require('express');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const router = express.Router();
const logger = require('../utils/logger');

// 1. Redirect ke Google
router.get('/google',
    passport.authenticate('google', {
        scope: ['profile', 'email'],
        prompt: 'select_account',
    })
);

// 2. Callback dari Google
router.get('/google/callback',
    passport.authenticate('google', {
        failureRedirect: '/clipora/login.php?error=google_failed',
        session: true,
    }),
    (req, res) => {
        logger.info(`[Google Auth] Login success: ${req.user.email}`);

        // Generate JWT untuk API
        const token = jwt.sign(
            {
                id: req.user.id,
                email: req.user.email,
                name: req.user.full_name || req.user.name || req.user.email.split('@')[0],
                role: req.user.role || 'user',
            },
            process.env.JWT_SECRET || process.env.SESSION_SECRET || 'change-me',
            { expiresIn: '7d' }
        );

        // Redirect ke dashboard dengan token
        res.redirect(`http://localhost/clipora/dashboard.php?token=${token}&login=google`);
    }
);

// 3. Get current user info
router.get('/me', (req, res) => {
    if (!req.user) {
        return res.status(401).json({ success: false, error: 'Not logged in' });
    }
    res.json({
        success: true,
        user: {
            id: req.user.id,
            email: req.user.email,
            name: req.user.full_name || req.user.name || req.user.email.split('@')[0],
            avatar: req.user.avatar_url,
        }
    });
});

// 4. Logout
router.post('/logout', (req, res) => {
    req.logout((err) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true });
    });
});

module.exports = router;