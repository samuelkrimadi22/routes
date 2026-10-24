// routes/onboarding.js - V9.1.0
// Track progress onboarding user baru
const express = require('express');
const { dbGet, dbRun } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// HELPER: Ensure row exists
// ============================================================
async function ensureOnboardingRow(userId) {
    const existing = await dbGet(
        'SELECT * FROM user_onboarding WHERE user_id = ?',
        [userId]
    );
    if (existing) return existing;

    await dbRun(
        `INSERT INTO user_onboarding (user_id) VALUES (?) RETURNING user_id`,
        [userId]
    );

    return await dbGet(
        'SELECT * FROM user_onboarding WHERE user_id = ?',
        [userId]
    );
}

// ============================================================
// HELPER: Compute progress
// ============================================================
function computeProgress(row) {
    const steps = [
        { key: 'welcome_seen',     label: 'Lihat sambutan',      done: !!row.welcome_seen },
        { key: 'tour_completed',   label: 'Selesaikan tour',     done: !!row.tour_completed || !!row.tour_skipped },
        { key: 'first_upload_done',label: 'Upload video pertama',done: !!row.first_upload_done },
        { key: 'first_render_done',label: 'Render pertama',      done: !!row.first_render_done },
        { key: 'sample_used',      label: 'Coba sample video',   done: !!row.sample_used },
    ];

    const doneCount = steps.filter(s => s.done).length;
    const percent = Math.round((doneCount / steps.length) * 100);

    return {
        steps,
        done_count: doneCount,
        total: steps.length,
        percent,
        completed: doneCount >= steps.length,
    };
}

// ============================================================
// GET /api/user/onboarding — Ambil progress
// ============================================================
router.get('/', requireAuth, async (req, res) => {
    try {
        const row = await ensureOnboardingRow(req.user.id);
        const progress = computeProgress(row);

        res.json({
            success: true,
            onboarding: {
                welcome_seen: row.welcome_seen,
                tour_completed: row.tour_completed,
                tour_skipped: row.tour_skipped,
                first_upload_done: row.first_upload_done,
                first_render_done: row.first_render_done,
                sample_used: row.sample_used,
                created_at: row.created_at,
            },
            progress,
        });
    } catch (e) {
        console.error('GET onboarding error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// POST /api/user/onboarding/step — Tandai step selesai
// Body: { step: 'welcome_seen' | 'tour_completed' | ... }
// ============================================================
router.post('/step', requireAuth, async (req, res) => {
    try {
        const { step } = req.body || {};
        const allowed = [
            'welcome_seen',
            'tour_completed',
            'tour_skipped',
            'first_upload_done',
            'first_render_done',
            'sample_used'
        ];

        if (!step || !allowed.includes(step)) {
            return res.status(400).json({
                success: false,
                error: 'Step tidak valid',
                allowed
            });
        }

        await ensureOnboardingRow(req.user.id);

        // Update step (set TRUE)
        await dbRun(
            `UPDATE user_onboarding
             SET ${step} = TRUE, updated_at = NOW()
             WHERE user_id = ?`,
            [req.user.id]
        );

        const row = await dbGet(
            'SELECT * FROM user_onboarding WHERE user_id = ?',
            [req.user.id]
        );

        res.json({
            success: true,
            step,
            onboarding: row,
            progress: computeProgress(row),
        });
    } catch (e) {
        console.error('POST onboarding step error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// POST /api/user/onboarding/reset — Reset progress (untuk testing)
// ============================================================
router.post('/reset', requireAuth, async (req, res) => {
    try {
        await dbRun(
            `UPDATE user_onboarding
             SET welcome_seen = FALSE,
                 tour_completed = FALSE,
                 tour_skipped = FALSE,
                 first_upload_done = FALSE,
                 first_render_done = FALSE,
                 sample_used = FALSE,
                 updated_at = NOW()
             WHERE user_id = ?`,
            [req.user.id]
        );

        const row = await ensureOnboardingRow(req.user.id);

        res.json({
            success: true,
            message: 'Onboarding direset',
            onboarding: row,
            progress: computeProgress(row),
        });
    } catch (e) {
        console.error('POST onboarding reset error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;