// routes/payment.js - Payment API (Midtrans) V8.8.0
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { dbRun, dbGet, dbAll } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const {
    getPlanConfig,
    createTransaction,
    verifyTransaction,
    verifyWebhookSignature,
    isPaymentSuccess
} = require('../services/midtrans');
const logger = require('../utils/logger');

// ============================================================
// POST /api/payment/create — Bikin Snap token
// ============================================================
router.post('/create', requireAuth, async (req, res) => {
    try {
        const { plan } = req.body || {};
        const userId = req.user.id;

        const planConfig = getPlanConfig(plan);
        if (!planConfig) {
            return res.status(400).json({
                success: false,
                error: 'Paket tidak valid'
            });
        }

        const user = await dbGet(
            'SELECT id, username, email FROM users WHERE id = ?',
            [userId]
        );

        if (!user) {
            return res.status(404).json({ success: false, error: 'User tidak ditemukan' });
        }

        const orderId = `CLIP-${Date.now()}-${uuidv4().slice(0, 6).toUpperCase()}`;

        console.log(`💳 [Payment] Create user ${userId} — ${plan} — ${orderId}`);

        const baseUrl = process.env.BASE_URL || 'http://localhost/clipcut';

                // V9.2.1: Hitung harga (early bird atau normal)
        const { getEffectivePrice } = require('../services/midtrans');
        
        // Ambil setting early bird dari DB
        let appSettings = { early_bird_limit: 100, early_bird_count: 0 };
        try {
            const rows = await dbAll(
                `SELECT key, value FROM app_settings WHERE key IN ('early_bird_limit', 'early_bird_count')`
            );
            rows.forEach(r => { appSettings[r.key] = r.value; });
        } catch (e) { /* pakai default */ }

        const effectivePrice = getEffectivePrice(plan, appSettings);
        console.log(`💰 [Payment] Plan: ${plan} | Normal: Rp${planConfig.price} | Effective: Rp${effectivePrice}`);

        const snapResult = await createTransaction({
            orderId,
            amount: effectivePrice,
            planKey: plan,
            user,
            baseUrl
        });

        // Simpan ke DB
        await dbRun(`
            INSERT INTO subscriptions 
            (user_id, plan, price, duration_days, status, 
             order_id, snap_token, gross_amount, payment_ref, created_at)
            VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, NOW())
        `, [
            userId,
            plan,
            effectivePrice,           // ← pakai effective price
            planConfig.duration_says || planConfig.duration_days,
            orderId,
            snapResult.token,
            effectivePrice,           // ← pakai effective price
            orderId
        ]);

        // Log activity
        try {
            await dbRun(`
                INSERT INTO activity_log (user_id, action, details, ip_address)
                VALUES (?, 'payment_create', ?, ?)
            `, [
                userId,
                `Create payment ${plan} Rp${planConfig.price} — ${orderId}`,
                req.ip
            ]);
        } catch (e) {}

        res.json({
            success: true,
            order_id: orderId,
            snap_token: snapResult.token,
            redirect_url: snapResult.redirect_url,
            amount: effectivePrice,   // ← pakai effective price
            plan_name: planConfig.name
        });

    } catch (e) {
        console.error('❌ [Payment] Create error:', e);
        logger.error('Payment create error', { error: e.message, userId: req.user?.id });
        res.status(500).json({
            success: false,
            error: e.message || 'Gagal membuat transaksi'
        });
    }
});

// ============================================================
// POST /api/payment/webhook — Callback dari Midtrans
// ============================================================
router.post('/webhook', async (req, res) => {
    try {
        const notification = req.body;

        console.log('📥 [Webhook] Received:', {
            order_id: notification.order_id,
            transaction_status: notification.transaction_status,
            payment_type: notification.payment_type
        });

        // Verifikasi signature
        if (!verifyWebhookSignature(notification)) {
            console.warn('⚠️  [Webhook] Invalid signature — REJECTED');
            return res.status(403).json({ success: false, error: 'Invalid signature' });
        }

        const { order_id, transaction_status, fraud_status, payment_type } = notification;

        const sub = await dbGet(
            'SELECT * FROM subscriptions WHERE order_id = ?',
            [order_id]
        );

        if (!sub) {
            console.warn(`⚠️  [Webhook] Subscription tidak ditemukan: ${order_id}`);
            return res.status(404).json({ success: false, error: 'Order tidak ditemukan' });
        }

        // Idempotent — kalau sudah aktif, skip
        if (sub.status === 'active') {
            console.log(`ℹ️  [Webhook] Already active: ${order_id}`);
            return res.json({ success: true, message: 'Already processed' });
        }

        // ✅ SUCCESS
        if (isPaymentSuccess(transaction_status, fraud_status)) {
                       const planConfig = getPlanConfig(sub.plan);

            // V9.2.1: Setelah sukses bayar, increment early_bird_count (kalau early price)
            const paidAmount = parseFloat(notification.gross_amount) || 0;
            if (paidAmount < planConfig.price && planConfig.early_price) {
                try {
                    await dbRun(
                        `UPDATE app_settings 
                         SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = NOW()
                         WHERE key = 'early_bird_count'`
                    );
                    console.log(`🎁 [Webhook] Early bird count incremented (paid Rp${paidAmount})`);
                } catch (e) {
                    console.warn('⚠️ Gagal increment early_bird_count:', e.message);
                }
            }

            await dbRun(`
                UPDATE subscriptions 
                SET status = 'active',
                    started_at = NOW(),
                    expires_at = NOW() + (INTERVAL '1 day' * ?),
                    paid_at = NOW(),
                    payment_method = ?,
                    midtrans_response = ?,
                    payment_ref = ?
                WHERE id = ?
            `, [
                planConfig.duration_days,
                payment_type,
                JSON.stringify(notification),
                notification.transaction_id,
                sub.id
            ]);

            await dbRun(
                'UPDATE users SET plan = ?, daily_quota = ? WHERE id = ?',
                [planConfig.db_plan, planConfig.daily_quota, sub.user_id]
            );

            await dbRun(`
                DELETE FROM quota_tracking 
                WHERE user_id = ? AND date = CURRENT_DATE
            `, [sub.user_id]);

            try {
                await dbRun(`
                    INSERT INTO notifications (user_id, type, title, message)
                    VALUES (?, 'subscription', '🎉 Pembayaran Berhasil!', ?)
                `, [
                    sub.user_id,
                    `Pembayaran ${planConfig.name} (Rp${planConfig.price.toLocaleString('id-ID')}) berhasil. Akun Anda sudah aktif sebagai ${planConfig.db_plan.toUpperCase()}!`
                ]);
            } catch (e) {}


            // ⭐ V9.8.0: Kirim receipt email ke user
            try {
                const emailService = require('../services/email');
                const userData = await dbGet(
                    'SELECT email, username, full_name FROM users WHERE id = ?',
                    [sub.user_id]
                );
                
                if (userData && userData.email) {
                    emailService.sendReceiptEmail({
                        to: userData.email,
                        username: userData.full_name || userData.username,
                        orderId: order_id,
                        plan: planConfig.name || sub.plan || 'Premium',
                        amount: paidAmount || planConfig.price,
                        method: notification.payment_type || '-',
                        date: new Date().toLocaleString('id-ID')
                    }).catch(err => console.error('⚠️  Receipt email failed:', err.message));
                    console.log('📧 [Webhook] Receipt email sent to ' + userData.email);
                }
            } catch (e) {
                console.error('⚠️  Receipt email error:', e.message);
            }

            console.log(`✅ [Webhook] SUCCESS: ${order_id} → user ${sub.user_id} upgraded`);
            return res.json({ success: true, message: 'Payment processed' });
        }

        // ⏳ PENDING
        if (transaction_status === 'pending') {
            await dbRun(`
                UPDATE subscriptions 
                SET payment_method = ?,
                    midtrans_response = ?,
                    payment_ref = ?
                WHERE id = ?
            `, [
                payment_type,
                JSON.stringify(notification),
                notification.transaction_id,
                sub.id
            ]);

            console.log(`⏳ [Webhook] PENDING: ${order_id}`);
            return res.json({ success: true, message: 'Pending' });
        }

        // ❌ FAILED
        if (['deny', 'cancel', 'expire', 'failure'].includes(transaction_status)) {
            await dbRun(`
                UPDATE subscriptions 
                SET status = 'rejected',
                    midtrans_response = ?,
                    payment_method = ?
                WHERE id = ?
            `, [
                JSON.stringify(notification),
                payment_type,
                sub.id
            ]);

            console.log(`❌ [Webhook] ${transaction_status.toUpperCase()}: ${order_id}`);
            return res.json({ success: true, message: 'Failed recorded' });
        }

        res.json({ success: true, message: 'Logged' });

    } catch (e) {
        console.error('❌ [Webhook] Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// GET /api/payment/status/:orderId
// ============================================================
router.get('/status/:orderId', requireAuth, async (req, res) => {
    try {
        const sub = await dbGet(`
            SELECT id, user_id, plan, price, status, order_id, 
                   payment_method, paid_at, started_at, expires_at
            FROM subscriptions 
            WHERE order_id = ? AND user_id = ?
        `, [req.params.orderId, req.user.id]);

        if (!sub) {
            return res.status(404).json({ success: false, error: 'Order tidak ditemukan' });
        }

        // Kalau masih pending, cek ke Midtrans
        if (sub.status === 'pending') {
            const midtransStatus = await verifyTransaction(req.params.orderId);
            return res.json({
                success: true,
                order: sub,
                midtrans: midtransStatus.success ? {
                    status: midtransStatus.status,
                    payment_type: midtransStatus.payment_type
                } : null
            });
        }

        res.json({ success: true, order: sub });

    } catch (e) {
        console.error('Payment status error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// GET /api/payment/history — Riwayat pembayaran
// ============================================================
router.get('/history', requireAuth, async (req, res) => {
    try {
        const history = await dbAll(`
            SELECT id, plan, price, status, order_id, 
                   payment_method, paid_at, created_at, expires_at
            FROM subscriptions
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 50
        `, [req.user.id]);

        res.json({ success: true, history });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
