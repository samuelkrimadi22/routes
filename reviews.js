// routes/reviews.js - V9.128.0
// Rating & Review system
const express = require('express');
const router = express.Router();
const { dbGet, dbRun, dbAll } = require('../database/db');

// V9.128.8: IMPORT REAL REQUIREAUTH - dari middleware/auth.js
const { requireAuth } = require('../middleware/auth');

function isAdmin(req) {
    if (!req.user) return false;
    return req.user.is_admin === true
        || req.user.is_admin === 1
        || req.user.is_admin === 'true';
}

// POST /api/reviews — Submit review
router.post('/', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const { rating, comment } = req.body;

        const ratingNum = parseInt(rating, 10);
        if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            return res.status(400).json({ success: false, error: 'Rating harus 1-5' });
        }

        let commentClean = null;
        if (comment && typeof comment === 'string') {
            commentClean = comment.trim().slice(0, 1000);
            if (commentClean === '') commentClean = null;
        }

        const existing = await dbGet('SELECT id FROM reviews WHERE user_id = ?', [userId]);

        let result;
        if (existing) {
            await dbRun(`
                UPDATE reviews SET rating = ?, comment = ?, updated_at = NOW()
                WHERE user_id = ?
            `, [ratingNum, commentClean, userId]);
            result = { id: existing.id, updated: true };
            console.log('[Review] User ' + userId + ' updated review: ' + ratingNum + ' star');
        } else {
            const insert = await dbGet(`
                INSERT INTO reviews (user_id, rating, comment)
                VALUES (?, ?, ?)
                RETURNING id
            `, [userId, ratingNum, commentClean]);
            result = { id: insert.id, created: true };
            console.log('[Review] User ' + userId + ' new review: ' + ratingNum + ' star');
        }

        res.json({ success: true, review: result });
    } catch (e) {
        console.error('[Review] POST error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/reviews — List reviews (public, paginated)
router.get('/', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));
        const offset = (page - 1) * limit;
        const ratingFilter = req.query.rating ? parseInt(req.query.rating, 10) : null;

        let whereClause = 'WHERE r.is_visible = TRUE';
        const params = [];

        if (ratingFilter && ratingFilter >= 1 && ratingFilter <= 5) {
            whereClause += ' AND r.rating = ?';
            params.push(ratingFilter);
        }

        const rows = await dbAll(`
            SELECT r.id, r.rating, r.comment, r.admin_reply, r.replied_at, r.created_at,
                   u.username
            FROM reviews r
            LEFT JOIN users u ON u.id = r.user_id
            ${whereClause}
            ORDER BY r.is_featured DESC, r.created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        const cleanRows = rows.map(r => ({
            id: r.id,
            rating: r.rating,
            comment: r.comment,
            admin_reply: r.admin_reply,
            replied_at: r.replied_at,
            created_at: r.created_at,
            username: r.username || 'Pengguna',
        }));

        const countRow = await dbGet(`
            SELECT COUNT(*)::int as total FROM reviews r ${whereClause}
        `, params);

        const stats = await dbGet(`
            SELECT 
                ROUND(AVG(rating)::numeric, 1) as avg_rating,
                COUNT(*)::int as total_reviews,
                SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END)::int as count_5,
                SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END)::int as count_4,
                SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END)::int as count_3,
                SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END)::int as count_2,
                SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END)::int as count_1
            FROM reviews
            WHERE is_visible = TRUE
        `);

        res.json({
            success: true,
            reviews: cleanRows,
            stats,
            pagination: {
                page,
                limit,
                total: countRow.total,
                totalPages: Math.ceil(countRow.total / limit)
            }
        });
    } catch (e) {
        console.error('[Review] GET error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/reviews/my — Review user sendiri
router.get('/my', requireAuth, async (req, res) => {
    try {
        const row = await dbGet(
            'SELECT id, rating, comment, created_at, updated_at FROM reviews WHERE user_id = ?',
            [req.user.id]
        );
        res.json({ success: true, review: row || null });
    } catch (e) {
        console.error('[Review] GET my error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE /api/reviews/my — Hapus review sendiri
router.delete('/my', requireAuth, async (req, res) => {
    try {
        await dbRun('DELETE FROM reviews WHERE user_id = ?', [req.user.id]);
        res.json({ success: true });
    } catch (e) {
        console.error('[Review] DELETE error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/reviews/admin/all — List all (admin)
router.get('/admin/all', requireAuth, async (req, res) => {
    if (!isAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Admin only' });
    }
    try {
        const rows = await dbAll(`
            SELECT r.*, u.username, u.email
            FROM reviews r
            LEFT JOIN users u ON u.id = r.user_id
            ORDER BY r.created_at DESC
            LIMIT 200
        `);
        res.json({ success: true, reviews: rows });
    } catch (e) {
        console.error('[Review] Admin GET error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// PUT /api/reviews/admin/:id/visibility
router.put('/admin/:id/visibility', requireAuth, async (req, res) => {
    if (!isAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Admin only' });
    }
    try {
        const id = parseInt(req.params.id, 10);
        const isVisible = req.body.is_visible === true;
        await dbRun('UPDATE reviews SET is_visible = ? WHERE id = ?', [isVisible, id]);
        console.log('[Review] Admin set review #' + id + ' visible=' + isVisible);
        res.json({ success: true });
    } catch (e) {
        console.error('[Review] Visibility error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// PUT /api/reviews/admin/:id/feature
router.put('/admin/:id/feature', requireAuth, async (req, res) => {
    if (!isAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Admin only' });
    }
    try {
        const id = parseInt(req.params.id, 10);
        const isFeatured = req.body.is_featured === true;
        await dbRun('UPDATE reviews SET is_featured = ? WHERE id = ?', [isFeatured, id]);
        console.log('[Review] Admin set review #' + id + ' featured=' + isFeatured);
        res.json({ success: true });
    } catch (e) {
        console.error('[Review] Feature error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/reviews/admin/:id/reply
router.post('/admin/:id/reply', requireAuth, async (req, res) => {
    if (!isAdmin(req)) {
        return res.status(403).json({ success: false, error: 'Admin only' });
    }
    try {
        const id = parseInt(req.params.id, 10);
        const reply = (req.body.reply || '').trim().slice(0, 1000);
        await dbRun(
            'UPDATE reviews SET admin_reply = ?, replied_at = NOW() WHERE id = ?',
            [reply || null, id]
        );
        console.log('[Review] Admin reply review #' + id);
        res.json({ success: true });
    } catch (e) {
        console.error('[Review] Reply error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;