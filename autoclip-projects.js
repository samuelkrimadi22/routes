// routes/autoclip-projects.js — V1.0.1 (Fixed: jwt position, validation)
const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { dbGet, dbAll, dbRun } = require("../database/db");
const { requireAuth, JWT_SECRET } = require("../middleware/auth");

const AUTOCLIP_DIR = path.join(__dirname, "..", "autoclip_projects");
if (!fs.existsSync(AUTOCLIP_DIR)) fs.mkdirSync(AUTOCLIP_DIR, { recursive: true });

// ============================================================
// HELPERS
// ============================================================
function getProjectLimit(user) {
    if (!user) return 0;
    if (user.is_admin === true || user.is_admin === 1) return 9999;
    const plan = (user.plan || "free").toLowerCase();
    if (["pro", "business", "weekly", "monthly"].includes(plan)) return 100;
    return 3;
}

function copyVideoToProject(srcPath, userId, projectId) {
    const userDir = path.join(AUTOCLIP_DIR, `user_${userId}`);
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    const ext = path.extname(srcPath) || ".mp4";
    const destPath = path.join(userDir, `${projectId}${ext}`);
    fs.copyFileSync(srcPath, destPath);
    return destPath;
}

// ============================================================
// POST /api/autoclip-projects — Save project baru
// ============================================================
router.post("/", requireAuth, async (req, res) => {
    try {
        let {
            name, inputVideoPath, analysisJson, clipsJson,
            preset, whisperModel, analysisId,
        } = req.body || {};

        // Validasi longgar: jika nama kosong, buat default
        if (!name || typeof name !== "string" || name.trim().length === 0) {
            name = "AutoClip " + Date.now();
        }

            // Validasi dilonggarkan: isi otomatis jika kosong
    if (!inputVideoPath) inputVideoPath = "uploads/placeholder.mp4";
    if (!analysisJson) analysisJson = {};
    if (!Array.isArray(clipsJson)) clipsJson = [];

        // Cek limit
        const limit = getProjectLimit(req.user);
        const countRow = await dbGet(
            "SELECT COUNT(*) as count FROM autoclip_projects WHERE user_id = ?",
            [req.user.id]
        );
        if (Number(countRow?.count || 0) >= limit) {
            return res.status(403).json({
                success: false,
                error: `Limit proyek Auto-Clip tercapai (${limit}). Hapus proyek lama atau upgrade.`,
                code: "LIMIT_REACHED",
            });
        }

                // Cek file video ada (DILONGGARKAN: tetap simpan meski file tidak ditemukan)
        if (!fs.existsSync(inputVideoPath)) {
            console.warn(`[AutoClipProjects] File tidak ada: ${inputVideoPath} - Tetap menyimpan proyek dengan placeholder.`);
            inputVideoPath = "uploads/placeholder.mp4"; // Paksa ganti ke placeholder
        }

        // Insert
        const result = await dbRun(
            `INSERT INTO autoclip_projects 
             (user_id, name, input_video_path, analysis_json, clips_json, 
              total_clips, rendered_count, preset, whisper_model, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING id`,
            [
                req.user.id,
                name.trim(),
                inputVideoPath,
                JSON.stringify(analysisJson),
                JSON.stringify(clipsJson),
                clipsJson.length,
                clipsJson.filter(c => c.rendered).length,
                preset || "1080p",
                whisperModel || "base",
                "draft",
            ]
        );

        const projectId = result.id;

        // Copy video ke folder permanen
        let permanentPath = inputVideoPath;
        try {
            permanentPath = copyVideoToProject(inputVideoPath, req.user.id, projectId);
            await dbRun(
                "UPDATE autoclip_projects SET input_video_path = ? WHERE id = ?",
                [permanentPath, projectId]
            );
        } catch (e) {
            console.log(`⚠️  [AutoClipProjects] Copy video gagal: ${e.message}`);
        }

        console.log(`💾 [AutoClipProjects] Saved "${name}" (user ${req.user.id}, ID: ${projectId})`);
        res.json({ success: true, projectId, message: "Proyek Auto-Clip tersimpan" });
    } catch (e) {
        console.error("❌ [AutoClipProjects] Create error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// GET /api/autoclip-projects — List proyek user
// ============================================================
router.get("/", requireAuth, async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT id, name, status, preset, total_clips, rendered_count,
                    whisper_model, created_at, updated_at,
                    input_video_path,
                    COALESCE(jsonb_array_length(clips_json), 0) as clip_count,
                    clips_json->0->>'thumbnailFile' as first_thumb_file,
                    clips_json->0->>'thumbnailUrl' as first_thumb_url,
                    clips_json->0->>'duration' as first_clip_duration
             FROM autoclip_projects
             WHERE user_id = ?
             ORDER BY updated_at DESC
             LIMIT 100`,
            [req.user.id]
        );
        res.json({ success: true, projects: rows });
    } catch (e) {
        console.error("❌ [AutoClipProjects] List error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// GET /api/autoclip-projects/:id — Detail proyek
// ============================================================
router.get("/:id", requireAuth, async (req, res) => {
    try {
        const row = await dbGet(
            "SELECT * FROM autoclip_projects WHERE id = ? AND user_id = ?",
            [req.params.id, req.user.id]
        );
        if (!row) return res.status(404).json({ success: false, error: "Proyek tidak ditemukan" });
        res.json({ success: true, project: row });
    } catch (e) {
        console.error("❌ [AutoClipProjects] Get error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// PUT /api/autoclip-projects/:id — Update proyek
// ============================================================
router.put("/:id", requireAuth, async (req, res) => {
    try {
        const existing = await dbGet(
            "SELECT id FROM autoclip_projects WHERE id = ? AND user_id = ?",
            [req.params.id, req.user.id]
        );
        if (!existing) return res.status(404).json({ success: false, error: "Proyek tidak ditemukan" });

        const { name, clipsJson, preset, status } = req.body || {};

        const renderedCount = Array.isArray(clipsJson)
            ? clipsJson.filter(c => c.rendered).length
            : null;

        let autoStatus = status;
        if (!autoStatus && Array.isArray(clipsJson)) {
            const total = clipsJson.length;
            const done = clipsJson.filter(c => c.rendered).length;
            if (done === 0) autoStatus = "draft";
            else if (done === total) autoStatus = "completed";
            else autoStatus = "partial";
        }

        await dbRun(
            `UPDATE autoclip_projects SET
                name = COALESCE(?, name),
                clips_json = COALESCE(?, clips_json),
                total_clips = COALESCE(?, total_clips),
                rendered_count = COALESCE(?, rendered_count),
                preset = COALESCE(?, preset),
                status = COALESCE(?, status)
             WHERE id = ?`,
            [
                name || null,
                clipsJson ? JSON.stringify(clipsJson) : null,
                Array.isArray(clipsJson) ? clipsJson.length : null,
                renderedCount,
                preset || null,
                autoStatus || null,
                req.params.id,
            ]
        );

        console.log(`💾 [AutoClipProjects] Updated ID ${req.params.id}`);
        res.json({ success: true, message: "Proyek diperbarui" });
    } catch (e) {
        console.error("❌ [AutoClipProjects] Update error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// DELETE /api/autoclip-projects/:id — Hapus proyek
// ============================================================
router.delete("/:id", requireAuth, async (req, res) => {
    try {
        const row = await dbGet(
            "SELECT input_video_path FROM autoclip_projects WHERE id = ? AND user_id = ?",
            [req.params.id, req.user.id]
        );
        if (!row) return res.status(404).json({ success: false, error: "Proyek tidak ditemukan" });

        try {
            if (row.input_video_path && fs.existsSync(row.input_video_path)
                && row.input_video_path.includes("autoclip_projects")) {
                fs.unlinkSync(row.input_video_path);
                console.log(`🗑️  [AutoClipProjects] Video dihapus: ${row.input_video_path}`);
            }
        } catch (e) {
            console.log(`⚠️  [AutoClipProjects] Hapus file gagal: ${e.message}`);
        }

        await dbRun("DELETE FROM autoclip_projects WHERE id = ?", [req.params.id]);
        console.log(`🗑️  [AutoClipProjects] Deleted ID ${req.params.id}`);
        res.json({ success: true, message: "Proyek dihapus" });
    } catch (e) {
        console.error("❌ [AutoClipProjects] Delete error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// V9.17.0: Thumbnail stream (ambil file thumbnail dari results/)
// ============================================================
router.get("/:id/thumbnail", async (req, res) => {
    try {
        let authUser = null;
        const authHeader = req.headers.authorization;
        let token = null;
        if (authHeader && authHeader.startsWith("Bearer ")) token = authHeader.substring(7);
        else if (req.query.token) token = String(req.query.token);

        if (token) {
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                authUser = await dbGet("SELECT id FROM users WHERE id = ?", [decoded.userId]);
            } catch (e) {}
        }
        if (!authUser) return res.status(401).end();

        const row = await dbGet(
            "SELECT id FROM autoclip_projects WHERE id = ? AND user_id = ?",
            [req.params.id, authUser.id]
        );
        if (!row) return res.status(404).end();

        var fileName = req.query.file;
        if (!fileName || typeof fileName !== 'string') return res.status(400).end();
        fileName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100);

        const resultsDir = path.join(__dirname, '..', 'results');
        const thumbPath = path.join(resultsDir, fileName);
        if (!thumbPath.startsWith(resultsDir)) return res.status(400).end();
        if (!fs.existsSync(thumbPath)) return res.status(404).end();

        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        fs.createReadStream(thumbPath).pipe(res);
    } catch (e) {
        console.error("❌ [AutoClipProjects] Thumb error:", e);
        res.status(500).end();
    }
});

// ============================================================
// V9.13.0: Video stream endpoint
// ============================================================
router.get("/:id/video", async (req, res) => {
    try {
        let authUser = null;
        const authHeader = req.headers.authorization;
        let token = null;
        if (authHeader && authHeader.startsWith("Bearer ")) token = authHeader.substring(7);
        else if (req.query.token) token = String(req.query.token);

        if (token) {
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                authUser = await dbGet("SELECT id FROM users WHERE id = ?", [decoded.userId]);
            } catch (e) {}
        }
        if (!authUser) return res.status(401).end();

        const row = await dbGet(
            "SELECT input_video_path FROM autoclip_projects WHERE id = ? AND user_id = ?",
            [req.params.id, authUser.id]
        );
        if (!row || !row.input_video_path) return res.status(404).end();

        const videoPath = row.input_video_path;
        if (!fs.existsSync(videoPath)) return res.status(404).end();

        const stat = fs.statSync(videoPath);
        const fileSize = stat.size;
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = (end - start) + 1;
            const stream = fs.createReadStream(videoPath, { start, end });
            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                "Accept-Ranges": "bytes",
                "Content-Length": chunkSize,
                "Content-Type": "video/mp4",
                "Cache-Control": "private, max-age=3600",
            });
            stream.pipe(res);
        } else {
            res.writeHead(200, {
                "Content-Length": fileSize,
                "Content-Type": "video/mp4",
                "Accept-Ranges": "bytes",
                "Cache-Control": "private, max-age=3600",
            });
            fs.createReadStream(videoPath).pipe(res);
        }
    } catch (e) {
        console.error("❌ [AutoClipProjects] Video error:", e);
        res.status(500).end();
    }
});

module.exports = router;