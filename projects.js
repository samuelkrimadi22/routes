// routes/projects.js — V1.0.0 (Save/Load Project)
const express = require("express");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../middleware/auth");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { dbGet, dbAll, dbRun } = require("../database/db");
const { requireAuth } = require("../middleware/auth");

const PROJECTS_DIR = path.join(__dirname, "..", "projects");
if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });

// ============================================================
// HELPERS
// ============================================================
function getProjectLimit(user) {
    if (!user) return 0;
    if (user.is_admin === true || user.is_admin === 1) return 9999;
    const plan = (user.plan || "free").toLowerCase();
    if (["pro", "business", "weekly", "monthly"].includes(plan)) return 500;
    return 10;
}

function copyVideoToProject(srcPath, userId, projectId) {
    const userDir = path.join(PROJECTS_DIR, `user_${userId}`);
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    const ext = path.extname(srcPath) || ".mp4";
    const destPath = path.join(userDir, `${projectId}${ext}`);
    fs.copyFileSync(srcPath, destPath);
    return destPath;
}

// ============================================================
// POST /api/projects — Simpan proyek baru
// ============================================================
router.post("/", requireAuth, async (req, res) => {
    try {
        const {
            name, inputVideoPath, analysisJson,
            translatedWords, translatedSegments, translateTarget,
            preset, enableBurnSubtitle, addWatermark,
        } = req.body || {};

        if (!name || typeof name !== "string" || name.trim().length === 0) {
            return res.status(400).json({ success: false, error: "Nama proyek wajib diisi" });
        }
        if (!inputVideoPath || !analysisJson) {
            return res.status(400).json({ success: false, error: "Data proyek tidak lengkap" });
        }

        // Cek limit
        const limit = getProjectLimit(req.user);
        const countRow = await dbGet("SELECT COUNT(*) as count FROM projects WHERE user_id = ?", [req.user.id]);
        if (Number(countRow?.count || 0) >= limit) {
            return res.status(403).json({
                success: false,
                error: `Limit proyek tercapai (${limit}). Hapus proyek lama atau upgrade.`,
            });
        }

        // Cek file video source ada
        if (!fs.existsSync(inputVideoPath)) {
            return res.status(400).json({ success: false, error: "File video sumber tidak ditemukan" });
        }

        // Insert
        const result = await dbRun(
            `INSERT INTO projects 
             (user_id, name, input_video_path, analysis_json, translated_words, translated_segments, 
              translate_target, preset, enable_burn_subtitle, add_watermark)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING id`,
            [
                req.user.id,
                name.trim(),
                inputVideoPath,
                JSON.stringify(analysisJson),
                translatedWords ? JSON.stringify(translatedWords) : null,
                translatedSegments ? JSON.stringify(translatedSegments) : null,
                translateTarget || null,
                preset || "720p",
                enableBurnSubtitle !== false,
                addWatermark !== false,
            ]
        );

        const projectId = result.id;

        // Copy video ke folder permanen
        let permanentPath = inputVideoPath;
        try {
            permanentPath = copyVideoToProject(inputVideoPath, req.user.id, projectId);
            await dbRun("UPDATE projects SET input_video_path = ? WHERE id = ?", [permanentPath, projectId]);
        } catch (e) {
            console.log("⚠️  [Projects] Copy video gagal:", e.message);
        }

        console.log(`💾 [Projects] Saved "${name}" (user ${req.user.id}, ID: ${projectId})`);
        res.json({ success: true, projectId, message: "Proyek tersimpan" });
    } catch (e) {
        console.error("❌ [Projects] Create error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// GET /api/projects — List proyek user
// ============================================================
router.get("/", requireAuth, async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT id, name, status, preset, translate_target, thumbnail_path,
                    created_at, updated_at, last_rendered_at,
                    COALESCE(jsonb_array_length(analysis_json->'segments'), 0) as segment_count
             FROM projects
             WHERE user_id = ?
             ORDER BY updated_at DESC
             LIMIT 100`,
            [req.user.id]
        );
        res.json({ success: true, projects: rows });
    } catch (e) {
        console.error("❌ [Projects] List error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// GET /api/projects/:id — Detail proyek
// ============================================================
router.get("/:id", requireAuth, async (req, res) => {
    try {
        const row = await dbGet(
            "SELECT * FROM projects WHERE id = ? AND user_id = ?",
            [req.params.id, req.user.id]
        );
        if (!row) return res.status(404).json({ success: false, error: "Proyek tidak ditemukan" });
        res.json({ success: true, project: row });
    } catch (e) {
        console.error("❌ [Projects] Get error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// PUT /api/projects/:id — Update proyek
// ============================================================
router.put("/:id", requireAuth, async (req, res) => {
    try {
        const existing = await dbGet(
            "SELECT id FROM projects WHERE id = ? AND user_id = ?",
            [req.params.id, req.user.id]
        );
        if (!existing) return res.status(404).json({ success: false, error: "Proyek tidak ditemukan" });

        const {
            name, analysisJson, translatedWords, translatedSegments, translateTarget,
            preset, enableBurnSubtitle, addWatermark, status, lastRenderFilename,
        } = req.body || {};

        await dbRun(
            `UPDATE projects SET
                name = COALESCE(?, name),
                analysis_json = COALESCE(?, analysis_json),
                translated_words = ?,
                translated_segments = ?,
                translate_target = COALESCE(?, translate_target),
                preset = COALESCE(?, preset),
                enable_burn_subtitle = COALESCE(?, enable_burn_subtitle),
                add_watermark = COALESCE(?, add_watermark),
                status = COALESCE(?, status),
                last_render_filename = COALESCE(?, last_render_filename),
                last_rendered_at = CASE WHEN ? IS NOT NULL THEN NOW() ELSE last_rendered_at END
             WHERE id = ?`,
            [
                name || null,
                analysisJson ? JSON.stringify(analysisJson) : null,
                translatedWords ? JSON.stringify(translatedWords) : null,
                translatedSegments ? JSON.stringify(translatedSegments) : null,
                translateTarget || null,
                preset || null,
                typeof enableBurnSubtitle === "boolean" ? enableBurnSubtitle : null,
                typeof addWatermark === "boolean" ? addWatermark : null,
                status || null,
                lastRenderFilename || null,
                lastRenderFilename || null,
                req.params.id,
            ]
        );

        console.log(`💾 [Projects] Updated ID ${req.params.id}`);
        res.json({ success: true, message: "Proyek diperbarui" });
    } catch (e) {
        console.error("❌ [Projects] Update error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// DELETE /api/projects/:id — Hapus proyek
// ============================================================
router.delete("/:id", requireAuth, async (req, res) => {
    try {
        const row = await dbGet(
            "SELECT input_video_path FROM projects WHERE id = ? AND user_id = ?",
            [req.params.id, req.user.id]
        );
        if (!row) return res.status(404).json({ success: false, error: "Proyek tidak ditemukan" });

        // Hapus file video permanen (kalau di folder projects/)
        try {
            if (row.input_video_path && fs.existsSync(row.input_video_path) && row.input_video_path.includes("projects")) {
                fs.unlinkSync(row.input_video_path);
                console.log(`🗑️  [Projects] Video file dihapus: ${row.input_video_path}`);
            }
        } catch (e) {
            console.log("⚠️  [Projects] Hapus file gagal:", e.message);
        }

        await dbRun("DELETE FROM projects WHERE id = ?", [req.params.id]);
        console.log(`🗑️  [Projects] Deleted ID ${req.params.id}`);
        res.json({ success: true, message: "Proyek dihapus" });
    } catch (e) {
        console.error("❌ [Projects] Delete error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// GET /api/projects/:id/video — Stream video (support range)
// ============================================================
router.get("/:id/video", async (req, res) => {
    try {
        // Auth: header OR query param (untuk tag <video>)
        let authUser = null;
        const authHeader = req.headers.authorization;
        let token = null;
        if (authHeader && authHeader.startsWith("Bearer ")) token = authHeader.substring(7);
        else if (req.query.token) token = String(req.query.token);

        if (token) {
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                authUser = await dbGet("SELECT id FROM users WHERE id = ?", [decoded.userId]);
            } catch (e) { /* invalid token */ }
        }
        if (!authUser) return res.status(401).end();

        const row = await dbGet(
            "SELECT input_video_path FROM projects WHERE id = ? AND user_id = ?",
            [req.params.id, authUser.id]
        );
        if (!row || !row.input_video_path) return res.status(404).json({ success: false, error: "Video tidak ditemukan" });

        const videoPath = row.input_video_path;
        if (!fs.existsSync(videoPath)) return res.status(404).json({ success: false, error: "File hilang dari disk" });

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
                "Content-Range": "bytes " + start + "-" + end + "/" + fileSize,
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
        console.error("❌ [Projects] Video stream error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================================
// GET /api/projects/:id/thumbnail — Generate/cache thumbnail
// ============================================================
router.get("/:id/thumbnail", async (req, res) => {
    try {
        // Auth: header OR query param
        let authUser = null;
        try {
            const authHeader = req.headers.authorization;
            let token = null;
            if (authHeader && authHeader.startsWith("Bearer ")) {
                token = authHeader.substring(7);
            } else if (req.query.token && typeof req.query.token === "string") {
                token = req.query.token;
            }
            if (token) {
                const decoded = jwt.verify(token, JWT_SECRET);
                authUser = await dbGet(
                    "SELECT id, email, username, plan, is_admin FROM users WHERE id = ?",
                    [decoded.userId]
                );
            }
        } catch (e) { /* token invalid */ }

        if (!authUser) return res.status(401).end();

        const row = await dbGet(
            "SELECT input_video_path, thumbnail_path FROM projects WHERE id = ? AND user_id = ?",
            [req.params.id, authUser.id]
        );
        if (!row || !row.input_video_path) return res.status(404).end();

        if (row.thumbnail_path && fs.existsSync(row.thumbnail_path)) {
            return res.sendFile(row.thumbnail_path);
        }

        const videoPath = row.input_video_path;
        if (!fs.existsSync(videoPath)) return res.status(404).end();

        const thumbDir = path.join(PROJECTS_DIR, "user_" + authUser.id, "thumbs");
        if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });
        const thumbPath = path.join(thumbDir, req.params.id + ".jpg");

        if (!fs.existsSync(thumbPath)) {
            const { spawnSync } = require("child_process");
            // V9.58.8: Portable FFmpeg path
const ffmpeg = process.env.FFMPEG_PATH || 
    (process.platform === 'win32' ? 'C:/ffmpeg/bin/ffmpeg.exe' : 'ffmpeg');
            spawnSync(ffmpeg, [
                "-y", "-ss", "2", "-i", videoPath,
                "-vframes", "1", "-vf", "scale=640:-1", "-q:v", "3",
                thumbPath,
            ], { timeout: 20000 });

            if (!fs.existsSync(thumbPath)) {
                spawnSync(ffmpeg, [
                    "-y", "-i", videoPath,
                    "-vframes", "1", "-vf", "scale=640:-1", "-q:v", "3",
                    thumbPath,
                ], { timeout: 20000 });
            }

            if (!fs.existsSync(thumbPath)) return res.status(404).end();
            await dbRun("UPDATE projects SET thumbnail_path = ? WHERE id = ?", [thumbPath, req.params.id]);
        }

        res.sendFile(thumbPath);
    } catch (e) {
        console.error("Thumbnail error:", e);
        res.status(500).end();
    }
});

module.exports = router;
