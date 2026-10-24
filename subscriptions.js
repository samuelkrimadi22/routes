// routes/subscriptions.js - Subscription untuk User
const express = require('express');
const { dbRun, dbGet, dbAll } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Semua route butuh login
router.use(requireAuth);

// ============================================================
// POST /api/subscriptions/request - User request langganan
// ============================================================
router.post('/request', async (req, res) => {
    try {
        const { plan, payment_method, payment_ref } = req.body;

        // Validasi plan
        const plans = {
            'weekly': { price: 15000, days: 7, name: 'Paket Mingguan' },
            'monthly': { price: 30000, days: 30, name: 'Paket Bulanan' }
        };

        if (!plans[plan]) {
            return res.status(400).json({ success: false, error: 'Paket tidak valid' });
        }

        // Cek apakah masih ada pending request
        const existing = await dbGet(`
            SELECT id FROM subscriptions 
            WHERE user_id = ? AND status = 'pending'
        `, [req.user.id]);

        if (existing) {
            return res.status(400).json({
                success: false,
                error: 'Anda masih memiliki permintaan yang menunggu konfirmasi admin'
            });
        }

        const planData = plans[plan];

        // Insert subscription request
        const result = await dbRun(`
            INSERT INTO subscriptions 
            (user_id, plan, price, duration_days, payment_method, payment_ref, status)
            VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `, [
            req.user.id,
            plan,
            planData.price,
            planData.days,
            payment_method || null,
            payment_ref || null
        ]);

        // Log activity
        await dbRun(`
            INSERT INTO activity_log (user_id, action, details)
            VALUES (?, 'subscription_request', ?)
        `, [req.user.id, `User request ${planData.name} (Rp${planData.price})`]);

        res.json({
            success: true,
            message: 'Permintaan langganan terkirim! Admin akan mengaktifkan dalam 1x24 jam.',
            subscription_id: result.id
        });

    } catch (error) {
        console.error('Subscription request error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// GET /api/subscriptions/me - Cek status subscription user
// ============================================================
router.get('/me', async (req, res) => {
    try {
        const subscriptions = await dbAll(`
            SELECT id, plan, price, status, started_at, expires_at, created_at
            FROM subscriptions
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 10
        `, [req.user.id]);

        // Cek subscription aktif
        const active = await dbGet(`
            SELECT * FROM subscriptions
            WHERE user_id = ? AND status = 'active'
                AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
            ORDER BY expires_at DESC
            LIMIT 1
        `, [req.user.id]);

        res.json({
            success: true,
            subscriptions,
            active: active || null,
            is_premium: !!active
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;