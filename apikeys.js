// routes/apikeys.js - API Key Management
const express = require('express');
const crypto = require('crypto');
const { dbRun, dbGet, dbAll } = require('../database/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function generateApiKey() {
    return 'clp_' + crypto.randomBytes(24).toString('hex');
}

// ============================================================
// GET /api/apikeys - List API keys user
// ============================================================
router.get('/', requireAuth, async (req, res) => {
    try {
        const keys = await dbAll(
            'SELECT id, key_name, api_key, is_active, last_used, usage_count, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
            [req.user.id]
        );
        // Mask sebagian key untuk keamanan
        const masked = keys.map(k => ({
            ...k,
            api_key: k.api_key.substring(0, 12) + '...' + k.api_key.slice(-4)
        }));
        res.json({ success: true, keys: masked });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// POST /api/apikeys - Buat API key baru
// ============================================================
router.post('/', requireAuth, async (req, res) => {
    try {
        const { key_name } = req.body;
        if (!key_name || key_name.length < 3) {
            return res.status(400).json({ success: false, error: 'Nama key minimal 3 karakter' });
        }

        // Batas maksimal 5 key per user
        const existing = await dbGet('SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?', [req.user.id]);
        if (existing.count >= 5) {
            return res.status(429).json({ success: false, error: 'Maksimal 5 API key per user' });
        }

        const api_key = generateApiKey();
        const result = await dbRun(
            'INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)',
            [req.user.id, key_name, api_key]
        );

        await dbRun('INSERT INTO activity_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)',
            [req.user.id, 'create_api_key', `Created key: ${key_name}`, req.ip]);

        res.status(201).json({
            success: true,
            message: 'API Key berhasil dibuat. Simpan key ini, tidak akan ditampilkan lagi.',
            api_key, // Full key hanya ditampilkan sekali
            id: result.id,
            key_name
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// DELETE /api/apikeys/:id - Hapus API key
// ============================================================
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const key = await dbGet('SELECT id FROM api_keys WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (!key) return res.status(404).json({ success: false, error: 'API key tidak ditemukan' });

        await dbRun('DELETE FROM api_keys WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'API key dihapus' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// PATCH /api/apikeys/:id/toggle - Aktifkan/nonaktifkan
// ============================================================
router.patch('/:id/toggle', requireAuth, async (req, res) => {
    try {
        const key = await dbGet('SELECT id, is_active FROM api_keys WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (!key) return res.status(404).json({ success: false, error: 'API key tidak ditemukan' });

        const newState = key.is_active ? 0 : 1;
        await dbRun('UPDATE api_keys SET is_active = ? WHERE id = ?', [newState, req.params.id]);
        res.json({ success: true, message: newState ? 'Aktif' : 'Nonaktif', is_active: newState });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;