// routes/auth.js - Authentication endpoints
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { dbRun, dbGet } = require('../database/db');
const { generateToken, requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// ============================================================
// POST /api/auth/register
// ============================================================
router.post('/register', authLimiter, [
    body('email').isEmail().normalizeEmail().withMessage('Email tidak valid'),
    body('username').isLength({ min: 3, max: 30 }).matches(/^[a-zA-Z0-9_]+$/).withMessage('Username harus 3-30 karakter alfanumerik'),
    body('password').isLength({ min: 6 }).withMessage('Password minimal 6 karakter'),
    body('full_name').optional().isLength({ max: 100 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { email, username, password, full_name } = req.body;

        // Cek email/username sudah ada
        const existing = await dbGet('SELECT id FROM users WHERE email = ? OR username = ?', [email, username]);
        if (existing) {
            return res.status(409).json({ success: false, error: 'Email atau username sudah terdaftar' });
        }

        // Hash password
        const password_hash = await bcrypt.hash(password, 10);

        // Insert user (default plan: free, quota 5)
        const result = await dbRun(
            'INSERT INTO users (email, username, password_hash, full_name, plan, daily_quota) VALUES (?, ?, ?, ?, ?, ?)',
            [email, username, password_hash, full_name || null, 'free', 5]
        );

        // Log activity
        await dbRun('INSERT INTO activity_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)',
            [result.id, 'register', `User ${username} mendaftar`, req.ip]);

        // Generate token
        const user = { id: result.id, email, username, full_name, plan: 'free', daily_quota: 5, is_admin: 0 };
        const token = generateToken(user);

        // ⭐ V9.8.0: Kirim welcome email (non-blocking)
        try {
            const emailService = require('../services/email');
            emailService.sendWelcomeEmail({
                to: email,
                username: username,
                fullName: full_name || username
            }).catch(e => console.error('⚠️  Welcome email failed:', e.message));
        } catch (e) {
            console.error('⚠️  Email service error:', e.message);
        }

        res.status(201).json({
            success: true,
            message: 'Registrasi berhasil',
            token,
            user: { id: user.id, email, username, full_name, plan: user.plan, daily_quota: 5 }
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ success: false, error: 'Gagal mendaftar' });
    }
});

// ============================================================
// POST /api/auth/login
// ============================================================
router.post('/login', authLimiter, [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, errors: errors.array() });
        }

        const { email, password } = req.body;

        const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Email atau password salah' });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ success: false, error: 'Email atau password salah' });
        }

        // Update last_login
        await dbRun('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

        // Log activity
        await dbRun('INSERT INTO activity_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)',
            [user.id, 'login', `User ${user.username} login`, req.ip]);

        // ⭐ V9.7.0: Cek apakah user butuh 2FA
        const twoFA = require('../services/twoFA');
        const needs2FA = await twoFA.checkUserNeeds2FA(user.id);
        
        if (needs2FA) {
            const tempToken = jwt.sign(
                { userId: user.id, pending_2fa: true },
                process.env.JWT_SECRET,
                { expiresIn: '15m' }
            );
            
            console.log('[Auth] 2FA required for user ' + user.id);
            
            return res.json({
                success: true,
                requires_2fa: true,
                temp_token: tempToken,
                message: 'Masukkan kode 6-digit dari Google Authenticator'
            });
        }
        
        const token = generateToken(user);

        res.json({
            success: true,
            message: 'Login berhasil',
            token,
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
                full_name: user.full_name,
                plan: user.plan,
                daily_quota: user.daily_quota,
                is_admin: user.is_admin
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: 'Gagal login' });
    }
});

// ============================================================
// GET /api/auth/me (current user)
// ============================================================
router.get('/me', requireAuth, async (req, res) => {
    res.json({ success: true, user: req.user });
});

// ============================================================
// POST /api/auth/logout
// ============================================================
router.post('/logout', requireAuth, async (req, res) => {
    // Log activity
    await dbRun('INSERT INTO activity_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)',
        [req.user.id, 'logout', `User ${req.user.username} logout`, req.ip]);

    // JWT stateless, jadi tidak ada session yang dihapus.
    // Client harus hapus token dari localStorage.
    res.json({ success: true, message: 'Logout berhasil' });
});


// ============================================================
// POST /api/auth/verify-2fa
// ⭐ V9.7.0: Verify 2FA token saat login admin
// ============================================================
router.post('/verify-2fa', authLimiter, async (req, res) => {
    try {
        const { temp_token, code } = req.body;
        
        if (!temp_token || !code) {
            return res.status(400).json({
                success: false,
                error: 'Token dan kode wajib diisi'
            });
        }

        let decoded;
        try {
            decoded = jwt.verify(temp_token, process.env.JWT_SECRET);
        } catch (e) {
            return res.status(401).json({
                success: false,
                error: 'Sesi expired. Login ulang.'
            });
        }

        if (!decoded.pending_2fa) {
            return res.status(400).json({
                success: false,
                error: 'Token tidak valid'
            });
        }

        const user = await dbGet('SELECT * FROM users WHERE id = ?', [decoded.userId]);

        if (!user) {
            return res.status(401).json({
                success: false,
                error: 'User tidak ditemukan'
            });
        }

        const twoFA = require('../services/twoFA');
        let verified = false;

        if (/^\d{6}$/.test(String(code).trim())) {
            verified = twoFA.verifyToken(user.two_fa_secret, code);
        }

        if (!verified) {
            verified = await twoFA.verifyBackupCode(user.id, code);
        }

        if (!verified) {
            return res.status(401).json({
                success: false,
                error: 'Kode salah. Coba lagi.'
            });
        }

        await dbRun('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
        await dbRun(
            'INSERT INTO activity_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)',
            [user.id, 'login_2fa', 'User ' + user.username + ' login via 2FA', req.ip]
        );

        const token = generateToken(user);

        console.log('[Auth] 2FA verified for user ' + user.id);

        res.json({
            success: true,
            message: 'Login berhasil',
            token,
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
                full_name: user.full_name,
                plan: user.plan,
                is_admin: user.is_admin,
            },
        });
    } catch (e) {
        console.error('Verify 2FA error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});


// ============================================================
// POST /api/auth/forgot-password
// ⭐ V9.8.0: Kirim email reset password
// ============================================================
router.post('/forgot-password', authLimiter, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, error: 'Email wajib diisi' });
        }

        const user = await dbGet('SELECT id, email, username FROM users WHERE email = ?', [email]);
        
        // Security: selalu return success (jangan bocorkan email terdaftar/tidak)
        if (!user) {
            console.log('[ForgotPassword] Email tidak terdaftar: ' + email);
            return res.json({
                success: true,
                message: 'Kalau email terdaftar, link reset sudah dikirim.'
            });
        }

        // Generate reset token (random)
        const crypto = require('crypto');
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 jam

        // Simpan ke DB
        await dbRun(
            'UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?',
            [resetToken, resetExpires, user.id]
        );

        // Kirim email
        const emailService = require('../services/email');
        const APP_URL = process.env.APP_URL || 'https://localhost/clipora';
        const resetLink = APP_URL + '/reset-password.php?token=' + resetToken;

        try {
            await emailService.sendPasswordResetEmail({
                to: user.email,
                username: user.username,
                resetLink: resetLink,
                expiresIn: '1 jam'
            });
            console.log('[ForgotPassword] Email sent to ' + user.email);
        } catch (emailErr) {
            console.error('[ForgotPassword] Email error:', emailErr.message);
        }

        res.json({
            success: true,
            message: 'Kalau email terdaftar, link reset sudah dikirim.'
        });
    } catch (e) {
        console.error('Forgot password error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// POST /api/auth/reset-password
// ⭐ V9.8.0: Reset password dengan token
// ============================================================
router.post('/reset-password', authLimiter, async (req, res) => {
    try {
        const { token, password } = req.body;
        
        if (!token || !password) {
            return res.status(400).json({ success: false, error: 'Token dan password wajib diisi' });
        }
        if (password.length < 6) {
            return res.status(400).json({ success: false, error: 'Password minimal 6 karakter' });
        }

        const user = await dbGet(
            'SELECT id, username, email FROM users WHERE reset_token = ? AND reset_expires > NOW()',
            [token]
        );

        if (!user) {
            return res.status(400).json({
                success: false,
                error: 'Link reset tidak valid atau sudah kadaluarsa'
            });
        }

        // Hash password baru
        const password_hash = await bcrypt.hash(password, 10);

        // Update password + hapus token
        await dbRun(
            'UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?',
            [password_hash, user.id]
        );

        // Log activity
        try {
            await dbRun(
                'INSERT INTO activity_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)',
                [user.id, 'password_reset', 'User ' + user.username + ' reset password', req.ip]
            );
        } catch (e) {}

        console.log('[ResetPassword] Success for ' + user.email);
        res.json({ success: true, message: 'Password berhasil direset. Silakan login.' });
    } catch (e) {
        console.error('Reset password error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
