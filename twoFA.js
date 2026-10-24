// routes/twoFA.js
// Endpoints untuk 2FA admin — V9.7.0
const express = require("express");
const router = express.Router();
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { requireAdmin: requireAdminMW } = require("../middleware/adminAuth");
const twoFA = require("../services/twoFA");
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");

const APP_NAME = process.env.APP_NAME || "Clipora";

router.use(requireAuth);
router.use(requireAdminMW);

// ============================================================
// GET /api/admin/2fa/status
// ============================================================
router.get("/status", async (req, res) => {
    try {
        const status = await twoFA.getStatus(req.user.id);
        res.json({ success: true, ...status });
    } catch (e) {
        console.error("2FA status error:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// POST /api/admin/2fa/setup
// ⭐ FIX: Reuse existing secret kalau sudah ada
// ============================================================
router.post("/setup", async (req, res) => {
    try {
        const { dbGet, dbRun } = require("../database/db");
        
        const user = await dbGet(
            `SELECT id, email, two_fa_secret, two_fa_enabled FROM public.users WHERE id = $1`,
            [req.user.id]
        );
        
        if (!user) {
            return res.status(404).json({ success: false, error: "User tidak ditemukan" });
        }

        // Kalau sudah enabled → tolak
        if (user.two_fa_enabled === true) {
            return res.status(400).json({
                success: false,
                error: "2FA sudah aktif. Disable dulu untuk setup ulang.",
            });
        }

        let secret, qr_code, otpauth_url;
        
        if (user.two_fa_secret) {
            // ⭐ REUSE existing secret (jangan generate baru!)
            console.log(`[2FA] Reusing existing secret for admin ${req.user.id}`);
            secret = user.two_fa_secret;
            
            // Re-generate QR dari secret yang ada
            otpauth_url = speakeasy.otpauthURL({
                secret: secret,
                label: `${APP_NAME} (${user.email})`,
                issuer: APP_NAME,
                encoding: "base32"
            });
            qr_code = await QRCode.toDataURL(otpauth_url);
        } else {
            // Generate secret baru (pertama kali setup)
            console.log(`[2FA] Generating NEW secret for admin ${req.user.id}`);
            const result = await twoFA.generateSecret(req.user);
            secret = result.secret;
            qr_code = result.qr_code;
            otpauth_url = result.otpauth_url;
            
            await dbRun(
                `UPDATE public.users SET two_fa_secret = $1 WHERE id = $2`,
                [secret, req.user.id]
            );
        }

        res.json({
            success: true,
            qr_code,
            secret,
            otpauth_url,
            message: "Scan QR dengan Google Authenticator, lalu masukkan kode 6-digit untuk verifikasi.",
        });
    } catch (e) {
        console.error("2FA setup error:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// POST /api/admin/2fa/enable
// ============================================================
router.post("/enable", async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) {
            return res.status(400).json({
                success: false,
                error: "Token 6-digit wajib diisi",
            });
        }

        const { dbGet, dbRun } = require("../database/db");
        const user = await dbGet(
            `SELECT two_fa_secret FROM public.users WHERE id = $1`,
            [req.user.id]
        );
        if (!user || !user.two_fa_secret) {
            return res.status(400).json({
                success: false,
                error: "Setup belum dimulai. Klik Setup 2FA dulu.",
            });
        }

        const result = await twoFA.enable2FA(req.user.id, user.two_fa_secret, token);

        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error,
            });
        }

        try {
            await dbRun(
                `INSERT INTO activity_log (user_id, action, details) VALUES ($1, '2fa_enabled', $2)`,
                [req.user.id, "2FA diaktifkan untuk admin"]
            );
        } catch (e) {}

        console.log(`[2FA] Enabled for admin ${req.user.id}`);

        res.json({
            success: true,
            backupCodes: result.backupCodes,
            message: "2FA aktif! Simpan backup codes di tempat aman.",
        });
    } catch (e) {
        console.error("2FA enable error:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// POST /api/admin/2fa/disable
// ============================================================
router.post("/disable", async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password) {
            return res.status(400).json({
                success: false,
                error: "Token 6-digit dan password wajib diisi",
            });
        }

        const result = await twoFA.disable2FA(req.user.id, token, password);

        if (!result.success) {
            return res.status(400).json({
                success: false,
                error: result.error,
            });
        }

        try {
            const { dbRun } = require("../database/db");
            await dbRun(
                `INSERT INTO activity_log (user_id, action, details) VALUES ($1, '2fa_disabled', $2)`,
                [req.user.id, "2FA dinonaktifkan oleh admin"]
            );
        } catch (e) {}

        console.log(`[2FA] Disabled for admin ${req.user.id}`);

        res.json({
            success: true,
            message: "2FA berhasil dinonaktifkan",
        });
    } catch (e) {
        console.error("2FA disable error:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// POST /api/admin/2fa/backup-codes/regenerate
// ============================================================
router.post("/backup-codes/regenerate", async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) {
            return res.status(400).json({
                success: false,
                error: "Token 6-digit wajib diisi",
            });
        }

        const { dbGet, dbRun } = require("../database/db");
        const user = await dbGet(
            `SELECT two_fa_secret, two_fa_enabled FROM public.users WHERE id = $1`,
            [req.user.id]
        );
        if (!user || !user.two_fa_enabled) {
            return res.status(400).json({
                success: false,
                error: "2FA belum aktif",
            });
        }

        if (!twoFA.verifyToken(user.two_fa_secret, token)) {
            return res.status(400).json({
                success: false,
                error: "Kode 2FA salah",
            });
        }

        const { plainCodes, hashedCodes } = await twoFA.generateBackupCodes(10);

        await dbRun(
            `UPDATE public.users SET two_fa_backup_codes = $1 WHERE id = $2`,
            [hashedCodes, req.user.id]
        );

        console.log(`[2FA] Backup codes regenerated for admin ${req.user.id}`);

        res.json({
            success: true,
            backupCodes: plainCodes,
            message: "Backup codes baru dibuat.",
        });
    } catch (e) {
        console.error("2FA regenerate error:", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;