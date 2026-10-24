// routes/analytics.js - Analytics Dashboard V9.1.0
const express = require('express');
const { dbGet, dbAll } = require('../database/db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// HELPER: validate days param
// ============================================================
function normalizeDays(input) {
    const allowed = [7, 30, 90];
    const d = parseInt(input);
    return allowed.includes(d) ? d : 7;
}

// ============================================================
// HELPER: calculate streak (consecutive days with activity)
// ============================================================
function calculateStreak(dateRows) {
    if (!dateRows || dateRows.length === 0) return 0;

    const set = new Set();
    for (const r of dateRows) {
        const raw = r.date;
        const key = raw instanceof Date
            ? raw.toISOString().slice(0, 10)
            : String(raw).slice(0, 10);
        set.add(key);
    }

    let streak = 0;
    const cursor = new Date();
    for (let i = 0; i < 365; i++) {
        const key = cursor.toISOString().slice(0, 10);
        if (set.has(key)) {
            streak++;
            cursor.setDate(cursor.getDate() - 1);
        } else {
            // Kalau hari ini belum ada aktivitas, mulai dari kemarin
            if (i === 0) {
                cursor.setDate(cursor.getDate() - 1);
                continue;
            }
            break;
        }
    }
    return streak;
}

// ============================================================
// GET /api/analytics/dashboard
// Query: ?days=7|30|90 (default 7)
// ============================================================
router.get('/dashboard', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const days = normalizeDays(req.query.days);

        // Parallel queries untuk performa
        const [
            totalVideos,
            durations,
            segments,
            dailyStats,
            presetRows,
            aggressivenessRows,
            whisperRows,
            streakRows,
            monthlyRow,
            weeklyRow,
            processingRow
        ] = await Promise.all([
            // Total videos
            dbGet('SELECT COUNT(*)::int as count FROM videos WHERE user_id = ?', [userId]),

            // Durations
            dbGet(`
                SELECT
                    COALESCE(SUM(original_duration), 0) as total_original,
                    COALESCE(SUM(new_duration), 0) as total_new,
                    COALESCE(SUM(saved_duration), 0) as total_saved,
                    COALESCE(AVG(saved_percent), 0) as avg_saved_percent
                FROM videos WHERE user_id = ?
            `, [userId]),

            // Segments
            dbGet(`
                SELECT
                    COALESCE(SUM(silences), 0) as total_silences,
                    COALESCE(SUM(ai_segments), 0) as total_ai,
                    COALESCE(SUM(filler_segments), 0) as total_filler,
                    COALESCE(SUM(stutter_segments), 0) as total_stutter,
                    COALESCE(SUM(false_start_segments), 0) as total_false_start,
                    COALESCE(SUM(llm_segments), 0) as total_llm,
                    COALESCE(SUM(scene_count), 0) as total_scene
                FROM videos WHERE user_id = ?
            `, [userId]),

            // Daily stats (dynamic range)
            dbAll(`
                SELECT
                    DATE(created_at) as date,
                    COUNT(*)::int as count,
                    COALESCE(SUM(saved_duration), 0) as saved
                FROM videos
                WHERE user_id = ? AND created_at >= NOW() - make_interval(days => ?)
                GROUP BY DATE(created_at)
                ORDER BY date ASC
            `, [userId, days]),

            // Preset breakdown
            dbAll(`
                SELECT
                    COALESCE(preset, 'unknown') as preset,
                    COUNT(*)::int as count
                FROM videos
                WHERE user_id = ?
                GROUP BY preset
                ORDER BY count DESC
                LIMIT 10
            `, [userId]),

            // Aggressiveness breakdown
            dbAll(`
                SELECT
                    COALESCE(aggressiveness, 'content') as aggressiveness,
                    COUNT(*)::int as count
                FROM videos
                WHERE user_id = ?
                GROUP BY aggressiveness
                ORDER BY count DESC
                LIMIT 10
            `, [userId]),

            // Whisper model breakdown
            dbAll(`
                SELECT
                    COALESCE(whisper_model, 'unknown') as model,
                    COUNT(*)::int as count
                FROM videos
                WHERE user_id = ? AND whisper_model IS NOT NULL
                GROUP BY whisper_model
                ORDER BY count DESC
                LIMIT 10
            `, [userId]),

            // Streak dates (last 365 days)
            dbAll(`
                SELECT DISTINCT DATE(created_at) as date
                FROM videos
                WHERE user_id = ? AND created_at >= NOW() - INTERVAL '365 days'
                ORDER BY date DESC
            `, [userId]),

            // Monthly count
            dbGet(`
                SELECT COUNT(*)::int as count
                FROM videos
                WHERE user_id = ?
                  AND created_at >= date_trunc('month', NOW())
            `, [userId]),

            // This week count
            dbGet(`
                SELECT COUNT(*)::int as count
                FROM videos
                WHERE user_id = ?
                  AND created_at >= date_trunc('week', NOW())
            `, [userId]),

            // Avg processing time
            dbGet(`
                SELECT
                    COALESCE(AVG(processing_time), 0) as avg_processing,
                    COALESCE(MIN(NULLIF(processing_time, 0)), 0) as fastest
                FROM videos
                WHERE user_id = ? AND processing_time > 0
            `, [userId])
        ]);

        const streak = calculateStreak(streakRows);

        res.json({
            success: true,
            stats: {
                // Existing
                totalVideos: totalVideos.count,
                totalOriginalDuration: durations.total_original,
                totalNewDuration: durations.total_new,
                totalSavedDuration: durations.total_saved,
                avgSavedPercent: Math.round(durations.avg_saved_percent * 10) / 10,
                segments: {
                    silences: segments.total_silences,
                    ai: segments.total_ai,
                    filler: segments.total_filler,
                    stutter: segments.total_stutter,
                    falseStart: segments.total_false_start,
                    llm: segments.total_llm,
                    scene: segments.total_scene
                },
                daily: dailyStats,

                // V9.1.0: New
                range: days,
                streak,
                monthlyVideos: monthlyRow.count,
                thisWeekVideos: weeklyRow.count,
                avgProcessingTime: Math.round(processingRow.avg_processing * 10) / 10,
                fastestProcessing: Math.round(processingRow.fastest * 10) / 10,
                presetBreakdown: presetRows,
                aggressivenessBreakdown: aggressivenessRows,
                whisperBreakdown: whisperRows
            }
        });
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// GET /api/analytics/admin - Stats global (admin only)
// ============================================================
router.get('/admin', requireAuth, requireAdmin, async (req, res) => {
    try {
        const totalUsers = await dbGet('SELECT COUNT(*)::int as count FROM users');
        const totalVideos = await dbGet('SELECT COUNT(*)::int as count FROM videos');
        const totalProcessed = await dbGet('SELECT COALESCE(SUM(saved_duration), 0) as total FROM videos');

        const userPlanStats = await dbAll(`
            SELECT plan, COUNT(*)::int as count FROM users GROUP BY plan
        `);

        const recentUsers = await dbAll(`
            SELECT id, email, username, plan, total_videos, created_at
            FROM users ORDER BY created_at DESC LIMIT 10
        `);

        const topUsers = await dbAll(`
            SELECT u.username, u.email, COUNT(v.id)::int as video_count,
                   COALESCE(SUM(v.saved_duration), 0) as total_saved
            FROM users u
            LEFT JOIN videos v ON v.user_id = u.id
            GROUP BY u.id
            ORDER BY video_count DESC
            LIMIT 10
        `);

        res.json({
            success: true,
            stats: {
                totalUsers: totalUsers.count,
                totalVideos: totalVideos.count,
                totalSavedDuration: totalProcessed.total,
                userPlanStats,
                recentUsers,
                topUsers
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;