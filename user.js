// routes/user.js - User profile, quota, history, notifications
const fs = require('fs');  // V9.135.3: FIX IMPORT FS
const express = require('express');
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { checkUserQuota } = require('../middleware/rateLimit');

const router = express.Router();

// ============================================================
// V8.9.22: Notification cache (30s TTL)
// ============================================================
const _notifCache = new Map();  // userId -> {data, ts}
const NOTIF_CACHE_TTL = 5 * 60 * 1000;

function _invalidateNotifCache(userId) {
    _notifCache.delete(userId);
}

function _invalidateAllNotifCache() {
    _notifCache.clear();
}

// ============================================================
// GET /api/user/profile
// ============================================================
router.get('/profile', requireAuth, async (req, res) => {
    try {
        const user = await dbGet(
            'SELECT id, email, username, full_name, plan, daily_quota, total_videos, is_admin, created_at, last_login FROM users WHERE id = ?',
            [req.user.id]
        );
        const quota = await checkUserQuota(req.user.id);

        res.json({
            success: true,
            user,
            quota: {
                used: quota.used,
                remaining: quota.remaining,
                total: quota.total
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// GET /api/user/history
// ============================================================
router.get('/history', requireAuth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const offset = parseInt(req.query.offset) || 0;

        const videos = await dbAll(
            `SELECT * FROM videos WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [req.user.id, limit, offset]
        );

        const total = await dbGet('SELECT COUNT(*)::int as count FROM videos WHERE user_id = ?', [req.user.id]);

        res.json({
            success: true,
            videos,
            pagination: {
                total: total.count,
                limit,
                offset,
                hasMore: offset + limit < total.count
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// V9.135.0: DELETE HISTORY - Hapus riwayat video
// ============================================================

// DELETE /api/user/history/:id - Hapus 1 video
router.delete('/history/:id', requireAuth, async (req, res) => {
    try {
        const video = await dbGet(
            "SELECT id, filename FROM videos WHERE id = ? AND user_id = ?",
            [req.params.id, req.user.id]
        );
        if (!video) return res.status(404).json({ success: false, error: 'Video tidak ditemukan' });

        // Hapus file dari results/ folder
        const path = require('path');
        const RESULT_DIR = process.env.CLIPORA_RESULTS_DIR || path.join(__dirname, '..', 'results');
        const filePath = path.join(RESULT_DIR, video.filename);

        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath);
                console.log('[DeleteHistory] File dihapus:', video.filename);
            } catch (e) {
                console.warn('[DeleteHistory] Gagal hapus file:', e.message);
            }
        }

        // Hapus dari DB
        await dbRun("DELETE FROM videos WHERE id = ? AND user_id = ?", [video.id, req.user.id]);
        console.log('[DeleteHistory] Video deleted:', video.id);

        res.json({ success: true, message: 'Riwayat dihapus' });
    } catch (error) {
        console.error('[DeleteHistory] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /api/user/history - Hapus semua
router.delete('/history', requireAuth, async (req, res) => {
    try {
        const videos = await dbAll("SELECT id, filename FROM videos WHERE user_id = ?", [req.user.id]);

        const path = require('path');
        const RESULT_DIR = process.env.CLIPORA_RESULTS_DIR || path.join(__dirname, '..', 'results');
        let deletedFiles = 0;

        for (const v of videos) {
            const filePath = path.join(RESULT_DIR, v.filename);
            if (fs.existsSync(filePath)) {
                try {
                    fs.unlinkSync(filePath);
                    deletedFiles++;
                } catch (e) {}
            }
        }

        await dbRun("DELETE FROM videos WHERE user_id = ?", [req.user.id]);
        console.log('[DeleteAllHistory] User ' + req.user.id + ' - ' + videos.length + ' videos deleted');

        res.json({
            success: true,
            deletedCount: videos.length,
            deletedFiles: deletedFiles
        });
    } catch (error) {
        console.error('[DeleteAllHistory] Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// ============================================================
// GET /api/user/quota
// ============================================================
router.get('/quota', requireAuth, async (req, res) => {
    try {
        const quota = await checkUserQuota(req.user.id);
        res.json({ success: true, quota });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// PUT /api/user/profile (update profile)
// ============================================================
router.put('/profile', requireAuth, async (req, res) => {
    try {
        const { full_name } = req.body;
        if (full_name) {
            await dbRun('UPDATE users SET full_name = ? WHERE id = ?', [full_name, req.user.id]);
        }
        res.json({ success: true, message: 'Profile diupdate' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// PUT /api/user/password - Ganti password
// ============================================================
router.put('/password', requireAuth, async (req, res) => {
    try {
        const { current_password, new_password } = req.body;

        if (!current_password || !new_password) {
            return res.status(400).json({ success: false, error: 'Semua field wajib diisi' });
        }
        if (new_password.length < 6) {
            return res.status(400).json({ success: false, error: 'Password minimal 6 karakter' });
        }
        if (current_password === new_password) {
            return res.status(400).json({ success: false, error: 'Password baru harus berbeda dari yang lama' });
        }

        // Ambil password hash user
        const user = await dbGet('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
        if (!user) {
            return res.status(404).json({ success: false, error: 'User tidak ditemukan' });
        }

        // Cek password lama
        const bcrypt = require('bcryptjs');
        const valid = await bcrypt.compare(current_password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ success: false, error: 'Password lama salah' });
        }

        // Hash password baru
        const newHash = await bcrypt.hash(new_password, 10);
        await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id]);

        // Log aktivitas
        await dbRun(`
            INSERT INTO activity_log (user_id, action, details)
            VALUES (?, 'user_change_password', 'User ganti password')
        `, [req.user.id]);

        res.json({ success: true, message: 'Password berhasil diganti' });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// GET /api/user/notifications - Ambil notifikasi user
// ============================================================
router.get('/notifications', requireAuth, async (req, res) => {
    const userId = req.user.id;

    // V8.9.22: Cache hit → response instant
    const cached = _notifCache.get(userId);
    if (cached && (Date.now() - cached.ts) < NOTIF_CACHE_TTL) {
        return res.json(cached.data);
    }

    try {
        // V8.9.22: Parallel query — 2 query jalan bersamaan
        const [notifications, unread] = await Promise.all([
            dbAll(`
                SELECT id, type, title, message, link, is_read, created_at
                FROM notifications
                WHERE user_id = ?
                ORDER BY created_at DESC
                LIMIT 20
            `, [userId]),
            dbGet(`
                SELECT COUNT(*)::int AS count FROM notifications
                WHERE user_id = ? AND is_read = 0
            `, [userId])
        ]);

        const response = {
            success: true,
            notifications,
            unread_count: unread.count
        };

        // Simpan ke cache
        _notifCache.set(userId, { data: response, ts: Date.now() });
        res.json(response);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// PATCH /api/user/notifications/:id/read - Tandai sudah dibaca
// ============================================================
router.patch('/notifications/:id/read', requireAuth, async (req, res) => {
    try {
        await dbRun(`
            UPDATE notifications SET is_read = 1
            WHERE id = ? AND user_id = ?
        `, [req.params.id, req.user.id]);

        _invalidateNotifCache(req.user.id);  // ⭐ V8.9.22
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// POST /api/user/notifications/read-all - Tandai semua dibaca
// ============================================================
router.post('/notifications/read-all', requireAuth, async (req, res) => {
    try {
        await dbRun(`
            UPDATE notifications SET is_read = 1
            WHERE user_id = ? AND is_read = 0
        `, [req.user.id]);

        _invalidateNotifCache(req.user.id);  // ⭐ V8.9.22
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;

// V8.9.22: Export cache helpers (biar bisa dipakai di file lain)
module.exports.invalidateNotifCache = _invalidateNotifCache;
module.exports.invalidateAllNotifCache = _invalidateAllNotifCache;