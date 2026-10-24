// routes/admin.js - Admin Control Panel API
const express = require("express");
const { dbRun, dbGet, dbAll, dbCount, pool } = require("../database/db");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/adminAuth");

const router = express.Router();

// ⭐ V9.8.0: Auto audit log untuk semua write action admin
const auditAdminActions = require('../middleware/auditMiddleware');
router.use(auditAdminActions);

// ============================================================
// PUBLIC ENDPOINT — untuk halaman harga (tanpa login)
// ============================================================
router.get("/settings-public", async (req, res) => {
  try {
    const rows = await dbAll(`
            SELECT key, value FROM app_settings
            WHERE key IN (
                'price_monthly', 'early_price_monthly',
                'early_bird_limit', 'early_bird_count',
                'whatsapp_admin', 'bank_name', 'bank_account', 'bank_owner',
                'support_email', 'guarantee_days', 'site_tagline'
            )
        `);
    const settings = {};
    rows.forEach((r) => {
      settings[r.key] = r.value;
    });
    res.json({ success: true, settings });
  } catch (e) {
    console.error("GET /settings-public error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// Semua route di bawah ini butuh login + admin
// ============================================================
router.use(requireAuth, requireAdmin);

// ============================================================
// GET /api/admin/stats - Statistik dashboard
// ============================================================
router.get("/stats", async (req, res) => {
  try {
    const totalUsers = await dbCount("users");
    const totalVideos = await dbCount("videos");
    const pendingSubs = await dbCount("subscriptions", "status = 'pending'");
    const activeSubs = await dbCount("subscriptions", "status = 'active'");
    const totalRevenue = await dbGet(`
            SELECT COALESCE(SUM(price), 0)::int AS total
            FROM subscriptions WHERE status = 'active'
        `);
    const newUsersToday = await dbCount(
      "users",
      "created_at::date = CURRENT_DATE",
    );

    res.json({
      success: true,
      stats: {
        total_users: totalUsers,
        total_videos: totalVideos,
        pending_subs: pendingSubs,
        active_subs: activeSubs,
        total_revenue: totalRevenue.total,
        new_users_today: newUsersToday,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /api/admin/users - List user + search + pagination
// ============================================================
router.get("/users", async (req, res) => {
  try {
    const { search = "", page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const searchLike = `%${search}%`;

    const users = await dbAll(
      `
            SELECT id, email, username, full_name, plan, daily_quota,
                   total_videos, is_admin, is_active, created_at, last_login
            FROM users
            WHERE email ILIKE ? OR username ILIKE ? OR COALESCE(full_name, '') ILIKE ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `,
      [searchLike, searchLike, searchLike, parseInt(limit), offset],
    );

    const total = await dbGet(
      `
            SELECT COUNT(*)::int AS c FROM users
            WHERE email ILIKE ? OR username ILIKE ? OR COALESCE(full_name, '') ILIKE ?
        `,
      [searchLike, searchLike, searchLike],
    );

    res.json({
      success: true,
      users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total.c,
        total_pages: Math.ceil(total.c / parseInt(limit)),
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /api/admin/users/:id - Detail user lengkap
// ============================================================
router.get("/users/:id", async (req, res) => {
  try {
    const userId = req.params.id;

    const user = await dbGet(
      `
            SELECT id, email, username, full_name, plan, daily_quota,
                   total_videos, is_admin, is_active, email_verified,
                   created_at, last_login
            FROM users
            WHERE id = ?
        `,
      [userId],
    );

    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: "User tidak ditemukan" });
    }

    const videos = await dbAll(
      `
            SELECT id, filename, original_duration, new_duration, saved_duration,
                   saved_percent, filesize_mb, preset, created_at
            FROM videos
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 10
        `,
      [userId],
    );

    const subscriptions = await dbAll(
      `
            SELECT id, plan, price, duration_days, status,
                   started_at, expires_at, created_at
            FROM subscriptions
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 20
        `,
      [userId],
    );

    const activities = await dbAll(
      `
            SELECT id, action, details, ip_address, created_at
            FROM activity_log
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 20
        `,
      [userId],
    );

    const stats = await dbGet(
      `
            SELECT
                COUNT(*)::int AS total_videos,
                COALESCE(SUM(saved_duration), 0)::int AS total_saved_seconds,
                COALESCE(AVG(saved_percent), 0)::numeric(5,1) AS avg_saved_percent,
                COALESCE(SUM(filesize_mb), 0)::numeric(10,2) AS total_size_mb
            FROM videos WHERE user_id = ?
        `,
      [userId],
    );

    const activeSub = await dbGet(
      `
            SELECT id, plan, expires_at FROM subscriptions
            WHERE user_id = ? AND status = 'active'
                AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY expires_at DESC LIMIT 1
        `,
      [userId],
    );

    res.json({
      success: true,
      user,
      videos,
      subscriptions,
      activities,
      stats,
      active_subscription: activeSub || null,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// PATCH /api/admin/users/:id - Update user
// ============================================================
router.patch("/users/:id", async (req, res) => {
  try {
    const { plan, daily_quota, is_active, is_admin } = req.body;
    const fields = [];
    const values = [];

    if (plan !== undefined) {
      fields.push("plan = ?");
      values.push(plan);
    }
    if (daily_quota !== undefined) {
      fields.push("daily_quota = ?");
      values.push(daily_quota);
    }
    if (is_active !== undefined) {
      fields.push("is_active = ?");
      values.push(is_active ? 1 : 0);
    }
    if (is_admin !== undefined) {
      fields.push("is_admin = ?");
      values.push(is_admin ? 1 : 0);
    }

    if (fields.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "Tidak ada field yang diubah" });
    }

    values.push(req.params.id);
    await dbRun(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, values);

    await dbRun(
      `
            INSERT INTO activity_log (user_id, action, details)
            VALUES (?, 'admin_update_user', ?)
        `,
      [req.user.id, `Admin update user #${req.params.id}`],
    );

    res.json({ success: true, message: "User berhasil diupdate" });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// DELETE /api/admin/users/:id - Hapus user
// ============================================================
router.delete("/users/:id", async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id) {
      return res
        .status(400)
        .json({ success: false, error: "Tidak bisa hapus akun sendiri" });
    }
    await dbRun("DELETE FROM users WHERE id = ?", [req.params.id]);
    await dbRun(
      `
            INSERT INTO activity_log (user_id, action, details)
            VALUES (?, 'admin_delete_user', ?)
        `,
      [req.user.id, `Admin hapus user #${req.params.id}`],
    );
    res.json({ success: true, message: "User dihapus" });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// POST /api/admin/users/:id/reset-quota
// ============================================================
router.post("/users/:id/reset-quota", async (req, res) => {
  try {
    const userId = req.params.id;

    await dbRun(
      `
            UPDATE quota_tracking
            SET videos_processed = 0
            WHERE user_id = ? AND date = CURRENT_DATE
        `,
      [userId],
    );

    await dbRun(
      `
            INSERT INTO activity_log (user_id, action, details)
            VALUES (?, 'admin_reset_quota', ?)
        `,
      [req.user.id, `Admin reset kuota user #${userId}`],
    );

    res.json({ success: true, message: "Kuota berhasil direset" });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// POST /api/admin/users/:id/force-logout
// ============================================================
router.post("/users/:id/force-logout", async (req, res) => {
  try {
    const userId = req.params.id;

    await dbRun(
      `
            INSERT INTO activity_log (user_id, action, details)
            VALUES (?, 'admin_force_logout', ?)
        `,
      [req.user.id, `Admin force logout user #${userId}`],
    );

    await dbRun(
      `
            INSERT INTO notifications (user_id, type, title, message)
            VALUES (?, 'system', 'Sesi Diakhiri', 'Sesi Anda telah diakhiri oleh admin. Silakan login ulang.')
        `,
      [userId],
    );

    res.json({
      success: true,
      message: "User akan logout saat refresh berikutnya",
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /api/admin/subscriptions - List subscription
// ============================================================
router.get("/subscriptions", async (req, res) => {
  try {
    const { status = "" } = req.query;
    let sql = `
            SELECT s.*, u.email, u.username, u.full_name
            FROM subscriptions s
            LEFT JOIN users u ON u.id = s.user_id
        `;
    const params = [];
    if (status) {
      sql += " WHERE s.status = ?";
      params.push(status);
    }
    sql += " ORDER BY s.created_at DESC LIMIT 100";

    const subs = await dbAll(sql, params);
    res.json({ success: true, subscriptions: subs });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// PATCH /api/admin/subscriptions/:id - Approve/Reject/Cancel
// ============================================================
router.patch("/subscriptions/:id", async (req, res) => {
  try {
    const { status } = req.body;
    const VALID_STATUSES = ["active", "rejected", "cancelled", "expired"];

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Status tidak valid. Pilih: ${VALID_STATUSES.join(", ")}`,
      });
    }

    const sub = await dbGet("SELECT * FROM subscriptions WHERE id = ?", [
      req.params.id,
    ]);
    if (!sub) {
      return res
        .status(404)
        .json({ success: false, error: "Subscription tidak ditemukan" });
    }

    // ============================================================
    // APPROVE — aktifkan langganan + upgrade user
    // ============================================================
    if (status === "active") {
      const planMap = {
        weekly: { db_plan: "pro", daily_quota: 50, days: 7 },
        monthly: { db_plan: "business", daily_quota: 200, days: 30 },
        pro: { db_plan: "pro", daily_quota: 50, days: 30 },
        business: { db_plan: "business", daily_quota: 200, days: 30 },
        yearly: { db_plan: "pro", daily_quota: 50, days: 365 },
        studio: { db_plan: "business", daily_quota: 200, days: 30 },
      };
      const mapping = planMap[sub.plan] || planMap["weekly"];
      const durationDays = sub.duration_days || mapping.days;

      // 1. Update subscription
      await dbRun(
        `
                UPDATE subscriptions 
                SET status = 'active',
                    started_at = NOW(),
                    expires_at = NOW() + (INTERVAL '1 day' * ?)
                WHERE id = ?
            `,
        [durationDays, req.params.id],
      );

      // 2. Upgrade user
      await dbRun("UPDATE users SET plan = ?, daily_quota = ? WHERE id = ?", [
        mapping.db_plan,
        mapping.daily_quota,
        sub.user_id,
      ]);

      // 3. Reset kuota hari ini (fresh start untuk user Pro)
      await dbRun(
        `
                DELETE FROM quota_tracking 
                WHERE user_id = ? AND date = CURRENT_DATE
            `,
        [sub.user_id],
      );

      // 4. Notifikasi user
      const planName =
        sub.plan === "monthly"
          ? "Bulanan"
          : sub.plan === "yearly"
            ? "Tahunan"
            : sub.plan === "studio"
              ? "Studio"
              : "Mingguan";

      await dbRun(
        `
                INSERT INTO notifications (user_id, type, title, message)
                VALUES (?, 'subscription', '🎉 Langganan Aktif!', ?)
            `,
        [
          sub.user_id,
          `Paket ${planName} Anda sudah aktif selama ${durationDays} hari ke depan. Selamat menggunakan!`,
        ],
      );

      console.log(
        `✅ [Admin] Approved subscription #${req.params.id} → user ${sub.user_id} upgraded to ${mapping.db_plan}`,
      );

      await dbRun(
        `
                INSERT INTO activity_log (user_id, action, details)
                VALUES (?, 'admin_subscription_active', ?)
            `,
        [
          req.user.id,
          `Admin approve subscription #${req.params.id} → ${planName} (${durationDays} hari)`,
        ],
      );

      return res.json({
        success: true,
        message: `Langganan #${req.params.id} di-approve — user jadi ${mapping.db_plan}`,
      });
    }

    // ============================================================
    // REJECT — tolak langganan pending (tidak sentuh user)
    // ============================================================
    if (status === "rejected") {
      await dbRun(
        `
                UPDATE subscriptions SET status = 'rejected' WHERE id = ?
            `,
        [req.params.id],
      );

      await dbRun(
        `
                INSERT INTO notifications (user_id, type, title, message)
                VALUES (?, 'subscription', '❌ Langganan Ditolak', 'Maaf, permintaan langganan Anda ditolak. Hubungi admin untuk info lebih lanjut.')
            `,
        [sub.user_id],
      );

      console.log(`❌ [Admin] Rejected subscription #${req.params.id}`);

      await dbRun(
        `
                INSERT INTO activity_log (user_id, action, details)
                VALUES (?, 'admin_subscription_rejected', ?)
            `,
        [req.user.id, `Admin reject subscription #${req.params.id}`],
      );

      return res.json({
        success: true,
        message: `Langganan #${req.params.id} ditolak`,
      });
    }

    // ============================================================
    // CANCEL — batalkan langganan aktif + DOWNGRADE user ke Free
    // ============================================================
    if (status === "cancelled") {
      // 1. Update subscription status
      await dbRun(
        `
                UPDATE subscriptions 
                SET status = 'cancelled', expires_at = NOW()
                WHERE id = ?
            `,
        [req.params.id],
      );

      // 2. ⭐ DOWNGRADE user ke Free
      await dbRun(
        `
                UPDATE users SET plan = 'free', daily_quota = 3 WHERE id = ?
            `,
        [sub.user_id],
      );

      // 3. Reset kuota hari ini (user Free dapat fresh start)
      await dbRun(
        `
                DELETE FROM quota_tracking 
                WHERE user_id = ? AND date = CURRENT_DATE
            `,
        [sub.user_id],
      );

      // 4. Notifikasi user
      await dbRun(
        `
                INSERT INTO notifications (user_id, type, title, message)
                VALUES (?, 'subscription', '🚫 Langganan Dibatalkan', 'Langganan Anda telah dibatalkan. Anda kembali ke paket Free (3 video/hari).')
            `,
        [sub.user_id],
      );

      console.log(
        `🗑️ [Admin] Cancelled subscription #${req.params.id} → user ${sub.user_id} DOWNGRADED to free`,
      );

      await dbRun(
        `
                INSERT INTO activity_log (user_id, action, details)
                VALUES (?, 'admin_subscription_cancelled', ?)
            `,
        [
          req.user.id,
          `Admin cancel subscription #${req.params.id} → user ${sub.user_id} downgraded to free`,
        ],
      );

      return res.json({
        success: true,
        message: `Langganan #${req.params.id} dibatalkan — user downgrade ke Free`,
      });
    }

    // ============================================================
    // EXPIRE — tandai kadaluarsa + downgrade user
    // ============================================================
    if (status === "expired") {
      await dbRun(
        `
                UPDATE subscriptions SET status = 'expired' WHERE id = ?
            `,
        [req.params.id],
      );

      await dbRun(
        `
                UPDATE users SET plan = 'free', daily_quota = 3 WHERE id = ?
            `,
        [sub.user_id],
      );

      console.log(
        `⏰ [Admin] Marked subscription #${req.params.id} as expired`,
      );

      await dbRun(
        `
                INSERT INTO activity_log (user_id, action, details)
                VALUES (?, 'admin_subscription_expired', ?)
            `,
        [req.user.id, `Admin expire subscription #${req.params.id}`],
      );

      return res.json({
        success: true,
        message: `Langganan #${req.params.id} ditandai kadaluarsa`,
      });
    }
  } catch (e) {
    console.error("❌ Update subscription error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /api/admin/videos - List semua video
// ============================================================
router.get("/videos", async (req, res) => {
  try {
    const videos = await dbAll(`
            SELECT v.*, u.email AS user_email, u.username
            FROM videos v
            LEFT JOIN users u ON u.id = v.user_id
            ORDER BY v.created_at DESC
            LIMIT 100
        `);
    res.json({ success: true, videos });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /api/admin/activity - Log aktivitas (dengan filter & pagination)
// ============================================================
router.get("/activity", async (req, res) => {
  try {
    const { range = "all", search = "", page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const searchLike = `%${search}%`;

    const whereParts = [];
    const params = [];

    // Filter tanggal
    if (range === "today") {
      whereParts.push(`a.created_at >= NOW() - INTERVAL '24 hours'`);
    } else if (range === "7days") {
      whereParts.push(`a.created_at >= NOW() - INTERVAL '7 days'`);
    } else if (range === "30days") {
      whereParts.push(`a.created_at >= NOW() - INTERVAL '30 days'`);
    }

    // Search filter
    if (search) {
      whereParts.push(
        `(a.action ILIKE ? OR COALESCE(a.details, '') ILIKE ? OR COALESCE(u.username, '') ILIKE ? OR COALESCE(u.email, '') ILIKE ?)`,
      );
      params.push(searchLike, searchLike, searchLike, searchLike);
    }

    const whereClause =
      whereParts.length > 0 ? "WHERE " + whereParts.join(" AND ") : "";

    const logs = await dbAll(
      `
            SELECT a.*, u.email, u.username
            FROM activity_log a
            LEFT JOIN users u ON u.id = a.user_id
            ${whereClause}
            ORDER BY a.created_at DESC
            LIMIT ? OFFSET ?
        `,
      [...params, parseInt(limit), offset],
    );

    const totalRow = await dbGet(
      `
            SELECT COUNT(*)::int AS c
            FROM activity_log a
            LEFT JOIN users u ON u.id = a.user_id
            ${whereClause}
        `,
      params,
    );

    res.json({
      success: true,
      logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalRow.c,
        total_pages: Math.ceil(totalRow.c / parseInt(limit)),
      },
    });
  } catch (e) {
    console.error("Activity error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// POST /api/admin/broadcast - Kirim notifikasi ke semua user
// ============================================================
router.post("/broadcast", async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!title || !message) {
      return res
        .status(400)
        .json({ success: false, error: "Title & message wajib" });
    }
    const users = await dbAll("SELECT id FROM users WHERE is_active = 1");
    for (const u of users) {
      await dbRun(
        `
                INSERT INTO notifications (user_id, type, title, message)
                VALUES (?, 'broadcast', ?, ?)
            `,
        [u.id, title, message],
      );
    }
    res.json({
      success: true,
      message: `Broadcast terkirim ke ${users.length} user`,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /api/admin/pending-summary - Ringkasan untuk bell admin
// ============================================================
router.get("/pending-summary", async (req, res) => {
  try {
    const pendingSubs = await dbCount("subscriptions", "status = 'pending'");
    const newUsersToday = await dbCount(
      "users",
      "created_at::date = CURRENT_DATE",
    );

    res.json({
      success: true,
      pending_subs: pendingSubs,
      new_users_today: newUsersToday,
      total_attention: pendingSubs + newUsersToday,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /api/admin/charts - Data untuk grafik dashboard
// ============================================================
router.get("/charts", async (req, res) => {
  try {
    const usersDaily = await dbAll(`
            SELECT
                TO_CHAR(d::date, 'DD Mon') AS label,
                d::date AS date,
                COALESCE(COUNT(u.id), 0)::int AS count
            FROM generate_series(
                CURRENT_DATE - INTERVAL '6 days',
                CURRENT_DATE,
                INTERVAL '1 day'
            ) AS d
            LEFT JOIN users u ON u.created_at::date = d::date
            GROUP BY d::date
            ORDER BY d::date ASC
        `);

    const videosDaily = await dbAll(`
            SELECT
                TO_CHAR(d::date, 'DD Mon') AS label,
                d::date AS date,
                COALESCE(COUNT(v.id), 0)::int AS count
            FROM generate_series(
                CURRENT_DATE - INTERVAL '6 days',
                CURRENT_DATE,
                INTERVAL '1 day'
            ) AS d
            LEFT JOIN videos v ON v.created_at::date = d::date
            GROUP BY d::date
            ORDER BY d::date ASC
        `);

    const revenueMonthly = await dbAll(`
            SELECT
                TO_CHAR(d::date, 'Mon YYYY') AS label,
                d::date AS month,
                COALESCE(SUM(s.price), 0)::int AS revenue
            FROM generate_series(
                DATE_TRUNC('month', CURRENT_DATE - INTERVAL '5 months'),
                DATE_TRUNC('month', CURRENT_DATE),
                INTERVAL '1 month'
            ) AS d
            LEFT JOIN subscriptions s
                ON DATE_TRUNC('month', s.created_at) = d::date
                AND s.status = 'active'
            GROUP BY d::date
            ORDER BY d::date ASC
        `);

    const planDistribution = await dbAll(`
            SELECT plan AS label, COUNT(*)::int AS count
            FROM users
            GROUP BY plan
            ORDER BY count DESC
        `);

    const summary = await dbGet(`
            SELECT
                (SELECT COUNT(*)::int FROM users WHERE created_at::date = CURRENT_DATE) AS users_today,
                (SELECT COUNT(*)::int FROM videos WHERE created_at::date = CURRENT_DATE) AS videos_today,
                (SELECT COALESCE(SUM(price), 0)::int FROM subscriptions 
                 WHERE status = 'active' 
                 AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)) AS revenue_this_month,
                (SELECT COUNT(*)::int FROM users WHERE plan IN ('pro', 'business')) AS premium_users
        `);

    res.json({
      success: true,
      usersDaily,
      videosDaily,
      revenueMonthly,
      planDistribution,
      summary,
    });
  } catch (e) {
    console.error("Charts error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /api/admin/settings - Ambil semua setting
// ============================================================
router.get("/settings", async (req, res) => {
  try {
    const rows = await dbAll("SELECT key, value FROM app_settings");
    const settings = {};
    rows.forEach((r) => {
      settings[r.key] = r.value;
    });
    res.json({ success: true, settings });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// PUT /api/admin/settings - Update setting
// ============================================================
router.put("/settings", async (req, res) => {
  try {
    const updates = req.body;

    if (!updates || typeof updates !== "object") {
      return res
        .status(400)
        .json({ success: false, error: "Data tidak valid" });
    }

    const ALLOWED_KEYS = [
      "price_monthly",
      "early_price_monthly",
      "early_bird_limit",
      "early_bird_count",
      "whatsapp_admin",
      "bank_name",
      "bank_account",
      "bank_owner",
      "support_email",
      "guarantee_days",
      "site_tagline",
    ];

    let updated = 0;
    for (const [key, value] of Object.entries(updates)) {
      if (!ALLOWED_KEYS.includes(key)) continue;

      await pool.query(
        `
                INSERT INTO app_settings (key, value, updated_at)
                VALUES ($1, $2, NOW())
                ON CONFLICT (key) DO UPDATE
                SET value = EXCLUDED.value, updated_at = NOW()
            `,
        [key, String(value)],
      );

      updated++;
    }

    await dbRun(
      `
            INSERT INTO activity_log (user_id, action, details)
            VALUES (?, 'admin_update_settings', ?)
        `,
      [req.user.id, `Admin update ${updated} setting`],
    );

    res.json({
      success: true,
      message: `${updated} setting berhasil disimpan`,
    });
  } catch (e) {
    console.error("Update settings error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// EXPORT CSV ENDPOINTS
// ============================================================

// Helper: convert array of objects → CSV string
function toCSV(rows, headers) {
  if (!rows || rows.length === 0) {
    return headers.join(",") + "\n";
  }

  const escapeCSV = (val) => {
    if (val === null || val === undefined) return "";
    const str = String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const headerRow = headers.map((h) => escapeCSV(h.label)).join(",");
  const dataRows = rows.map((row) =>
    headers.map((h) => escapeCSV(row[h.key])).join(","),
  );

  return [headerRow, ...dataRows].join("\n");
}

// ============================================================
// GET /api/admin/export/users - Export data users ke CSV
// ============================================================
router.get("/export/users", async (req, res) => {
  try {
    const users = await dbAll(`
            SELECT id, email, username, full_name, plan, daily_quota,
                   total_videos, is_active, is_admin, created_at, last_login
            FROM users
            ORDER BY created_at DESC
        `);

    const headers = [
      { key: "id", label: "ID" },
      { key: "email", label: "Email" },
      { key: "username", label: "Username" },
      { key: "full_name", label: "Nama Lengkap" },
      { key: "plan", label: "Plan" },
      { key: "daily_quota", label: "Kuota Harian" },
      { key: "total_videos", label: "Total Video" },
      { key: "is_active", label: "Aktif" },
      { key: "is_admin", label: "Admin" },
      { key: "created_at", label: "Bergabung" },
      { key: "last_login", label: "Last Login" },
    ];

    const formatted = users.map((u) => ({
      ...u,
      is_active: u.is_active ? "YA" : "TIDAK",
      is_admin: u.is_admin ? "YA" : "TIDAK",
      created_at: u.created_at
        ? new Date(u.created_at).toLocaleString("id-ID")
        : "",
      last_login: u.last_login
        ? new Date(u.last_login).toLocaleString("id-ID")
        : "Belum pernah",
    }));

    const csv = toCSV(formatted, headers);
    const filename = `clipora_users_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send("\uFEFF" + csv);
  } catch (e) {
    console.error("Export users error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /api/admin/export/subscriptions - Export subscriptions ke CSV
// ============================================================
router.get("/export/subscriptions", async (req, res) => {
  try {
    const subs = await dbAll(`
            SELECT s.id, s.plan, s.price, s.duration_days, s.status,
                   s.started_at, s.expires_at, s.created_at,
                   u.username, u.email, u.full_name
            FROM subscriptions s
            LEFT JOIN users u ON u.id = s.user_id
            ORDER BY s.created_at DESC
        `);

    const headers = [
      { key: "id", label: "ID" },
      { key: "username", label: "Username" },
      { key: "email", label: "Email" },
      { key: "full_name", label: "Nama Lengkap" },
      { key: "plan", label: "Paket" },
      { key: "price", label: "Harga (Rp)" },
      { key: "duration_days", label: "Durasi (hari)" },
      { key: "status", label: "Status" },
      { key: "started_at", label: "Mulai" },
      { key: "expires_at", label: "Berakhir" },
      { key: "created_at", label: "Dibuat" },
    ];

    const formatted = subs.map((s) => ({
      ...s,
      started_at: s.started_at
        ? new Date(s.started_at).toLocaleString("id-ID")
        : "",
      expires_at: s.expires_at
        ? new Date(s.expires_at).toLocaleString("id-ID")
        : "",
      created_at: s.created_at
        ? new Date(s.created_at).toLocaleString("id-ID")
        : "",
    }));

    const csv = toCSV(formatted, headers);
    const filename = `clipora_subscriptions_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send("\uFEFF" + csv);
  } catch (e) {
    console.error("Export subscriptions error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /api/admin/export/activity - Export activity log ke CSV
// ============================================================
router.get("/export/activity", async (req, res) => {
  try {
    const { range = "all" } = req.query;

    let whereClause = "";
    if (range === "today") {
      whereClause = `WHERE a.created_at >= NOW() - INTERVAL '24 hours'`;
    } else if (range === "7days") {
      whereClause = `WHERE a.created_at >= NOW() - INTERVAL '7 days'`;
    } else if (range === "30days") {
      whereClause = `WHERE a.created_at >= NOW() - INTERVAL '30 days'`;
    }

    const logs = await dbAll(`
            SELECT a.id, a.action, a.details, a.ip_address, a.created_at,
                   u.username, u.email
            FROM activity_log a
            LEFT JOIN users u ON u.id = a.user_id
            ${whereClause}
            ORDER BY a.created_at DESC
        `);

    const headers = [
      { key: "id", label: "ID" },
      { key: "username", label: "Username" },
      { key: "email", label: "Email" },
      { key: "action", label: "Action" },
      { key: "details", label: "Detail" },
      { key: "ip_address", label: "IP Address" },
      { key: "created_at", label: "Waktu" },
    ];

    const formatted = logs.map((l) => ({
      ...l,
      username: l.username || "System",
      email: l.email || "-",
      created_at: l.created_at
        ? new Date(l.created_at).toLocaleString("id-ID")
        : "",
    }));

    const csv = toCSV(formatted, headers);
    const filename = `clipora_activity_${range}_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send("\uFEFF" + csv);
  } catch (e) {
    console.error("Export activity error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /api/admin/export/videos - Export video ke CSV
// ============================================================
router.get("/export/videos", async (req, res) => {
  try {
    const videos = await dbAll(`
            SELECT v.id, v.filename, v.original_duration, v.new_duration,
                   v.saved_duration, v.saved_percent, v.filesize_mb,
                   v.preset, v.aggressiveness, v.created_at,
                   u.username, u.email
            FROM videos v
            LEFT JOIN users u ON u.id = v.user_id
            ORDER BY v.created_at DESC
        `);

    const headers = [
      { key: "id", label: "ID" },
      { key: "username", label: "Username" },
      { key: "email", label: "Email" },
      { key: "filename", label: "File" },
      { key: "original_duration", label: "Durasi Asli (detik)" },
      { key: "new_duration", label: "Durasi Baru (detik)" },
      { key: "saved_duration", label: "Hemat (detik)" },
      { key: "saved_percent", label: "Hemat (%)" },
      { key: "filesize_mb", label: "Ukuran (MB)" },
      { key: "preset", label: "Preset" },
      { key: "aggressiveness", label: "Aggressiveness" },
      { key: "created_at", label: "Tanggal" },
    ];

    const formatted = videos.map((v) => ({
      ...v,
      username: v.username || "Guest",
      email: v.email || "-",
      original_duration: v.original_duration
        ? v.original_duration.toFixed(1)
        : "0",
      new_duration: v.new_duration ? v.new_duration.toFixed(1) : "0",
      saved_duration: v.saved_duration ? v.saved_duration.toFixed(1) : "0",
      saved_percent: v.saved_percent ? v.saved_percent.toFixed(1) : "0",
      created_at: v.created_at
        ? new Date(v.created_at).toLocaleString("id-ID")
        : "",
    }));

    const csv = toCSV(formatted, headers);
    const filename = `clipora_videos_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send("\uFEFF" + csv);
  } catch (e) {
    console.error("Export videos error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// POST /api/admin/users/bulk-action - Bulk action untuk banyak user
// ============================================================
router.post("/users/bulk-action", async (req, res) => {
  try {
    const { action, userIds, value } = req.body;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "Tidak ada user yang dipilih" });
    }

    if (!["delete", "activate", "deactivate", "update-plan"].includes(action)) {
      return res
        .status(400)
        .json({ success: false, error: "Aksi tidak valid" });
    }

    if (action === "delete" && userIds.includes(req.user.id)) {
      return res.status(400).json({
        success: false,
        error:
          "Tidak bisa hapus akun sendiri. Hilangkan centang pada akun Anda.",
      });
    }

    const placeholders = userIds.map(() => "?").join(",");

    let result;
    let logMsg = "";

    switch (action) {
      case "delete":
        result = await dbRun(
          `DELETE FROM users WHERE id IN (${placeholders})`,
          userIds,
        );
        logMsg = `Admin hapus ${result.changes} user sekaligus (IDs: ${userIds.join(", ")})`;
        break;

      case "activate":
        result = await dbRun(
          `UPDATE users SET is_active = 1 WHERE id IN (${placeholders})`,
          userIds,
        );
        logMsg = `Admin aktifkan ${result.changes} user (IDs: ${userIds.join(", ")})`;
        break;

      case "deactivate":
        result = await dbRun(
          `UPDATE users SET is_active = 0 WHERE id IN (${placeholders})`,
          userIds,
        );
        logMsg = `Admin nonaktifkan ${result.changes} user (IDs: ${userIds.join(", ")})`;
        break;

      case "update-plan":
        if (!value || !["free", "pro", "business"].includes(value)) {
          return res
            .status(400)
            .json({ success: false, error: "Plan tidak valid" });
        }
        result = await dbRun(
          `UPDATE users SET plan = ? WHERE id IN (${placeholders})`,
          [value, ...userIds],
        );
        logMsg = `Admin ubah plan ${result.changes} user ke ${value} (IDs: ${userIds.join(", ")})`;
        break;
    }

    await dbRun(
      `
            INSERT INTO activity_log (user_id, action, details)
            VALUES (?, 'admin_bulk_action', ?)
        `,
      [req.user.id, logMsg],
    );

    res.json({
      success: true,
      message: `${result.changes} user berhasil diproses`,
      affected: result.changes,
    });
  } catch (e) {
    console.error("Bulk action error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /api/admin/backup/stats - Statistik database untuk halaman backup
// ============================================================
router.get("/backup/stats", async (req, res) => {
  try {
    const tables = [
      "users",
      "videos",
      "subscriptions",
      "notifications",
      "activity_log",
      "api_keys",
      "quota_tracking",
      "app_settings",
    ];
    const stats = {};

    for (const table of tables) {
      try {
        const count = await dbCount(table);
        stats[table] = count;
      } catch (e) {
        stats[table] = 0;
      }
    }

    let dbSize = "N/A";
    try {
      const r = await dbGet(
        `SELECT pg_size_pretty(pg_database_size(current_database())) AS size`,
      );
      dbSize = r?.size || "N/A";
    } catch (e) {}

    const lastBackup = await dbGet(`
            SELECT created_at, details
            FROM activity_log
            WHERE action = 'admin_manual_backup'
            ORDER BY created_at DESC
            LIMIT 1
        `);

    res.json({
      success: true,
      stats,
      dbSize,
      lastBackup: lastBackup || null,
      totalRecords: Object.values(stats).reduce((a, b) => a + b, 0),
    });
  } catch (e) {
    console.error("Backup stats error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /api/admin/backup/download - Export semua data ke JSON
// ============================================================
router.get("/backup/download", async (req, res) => {
  try {
    console.log("💾 [Backup] Memulai backup manual...");

    const backup = {
      meta: {
        version: "V7",
        type: "manual_backup",
        created_at: new Date().toISOString(),
        created_by: {
          id: req.user.id,
          username: req.user.username,
          email: req.user.email,
        },
        database: "PostgreSQL (Supabase)",
      },
      data: {},
    };

    const tables = [
      "users",
      "videos",
      "subscriptions",
      "notifications",
      "activity_log",
      "api_keys",
      "quota_tracking",
      "app_settings",
    ];

    for (const table of tables) {
      try {
        const rows = await dbAll(`SELECT * FROM ${table}`);
        backup.data[table] = rows;
        console.log(`   ✅ ${table}: ${rows.length} rows`);
      } catch (e) {
        console.warn(`   ⚠️ ${table}: ${e.message}`);
        backup.data[table] = [];
      }
    }

    const totalRows = Object.values(backup.data).reduce(
      (a, arr) => a + arr.length,
      0,
    );
    await dbRun(
      `
            INSERT INTO activity_log (user_id, action, details)
            VALUES (?, 'admin_manual_backup', ?)
        `,
      [
        req.user.id,
        `Backup manual: ${totalRows} rows dari ${tables.length} tabel`,
      ],
    );

    const json = JSON.stringify(backup, null, 2);
    const filename = `clipora_backup_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;

    console.log(
      `   🎉 Backup selesai: ${totalRows} rows, ${(json.length / 1024).toFixed(2)} KB`,
    );

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(json);
  } catch (e) {
    console.error("❌ Backup error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// LOGS ENDPOINTS
// ============================================================

const logger = require("../utils/logger");

// ============================================================
// GET /api/admin/logs - List file log
// ============================================================
router.get("/logs", async (req, res) => {
  try {
    const files = logger.listLogFiles();
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    res.json({
      success: true,
      files,
      totalFiles: files.length,
      totalSize,
      totalSizeFormatted: (totalSize / 1024).toFixed(2) + " KB",
    });
  } catch (e) {
    console.error("List logs error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// GET /api/admin/logs/:filename - Baca isi file log
// ============================================================
router.get("/logs/:filename", async (req, res) => {
  try {
    const { filename } = req.params;
    const lines = Math.min(parseInt(req.query.lines) || 200, 1000);

    const result = logger.readLog(filename, lines);

    res.json({
      success: true,
      filename: result.filename,
      lines: result.lines,
      totalLines: result.totalLines,
      size: result.size,
      sizeFormatted: (result.size / 1024).toFixed(2) + " KB",
    });
  } catch (e) {
    console.error("Read log error:", e);
    res.status(400).json({ success: false, error: e.message });
  }
});

// ============================================================
// DELETE /api/admin/logs/:filename - Hapus file log
// ============================================================
router.delete("/logs/:filename", async (req, res) => {
  try {
    const { filename } = req.params;

    const deleted = logger.deleteLog(filename);

    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, error: "File log tidak ditemukan" });
    }

    await dbRun(
      `
            INSERT INTO activity_log (user_id, action, details)
            VALUES (?, 'admin_delete_log', ?)
        `,
      [req.user.id, `Admin hapus log file: ${filename}`],
    );

    res.json({
      success: true,
      message: `File log "${filename}" berhasil dihapus`,
    });
  } catch (e) {
    console.error("Delete log error:", e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================================
// ADMIN: Find user by email
// ============================================================
router.get("/find-user", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { email } = req.query;
    if (!email)
      return res
        .status(400)
        .json({ success: false, error: "Email wajib diisi" });

    const cleanEmail = email.toLowerCase().trim();

    const user = await dbGet("SELECT * FROM users WHERE LOWER(email) = ?", [
      cleanEmail,
    ]);

    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: "User tidak ditemukan" });
    }

    const normalized = {
      id: user.id,
      name: user.full_name || user.username || "Tanpa Nama",
      username: user.username || "-",
      email: user.email,
      plan: user.plan || "free",
      is_admin: user.is_admin || false,
    };

    res.json({ success: true, user: normalized });
  } catch (err) {
    console.error("❌ find-user error:", err);
    logger.error("Find user error", { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// V9.26.1: Fix password column (password -> password_hash)
// ADMIN: Reset user password (generate temp password)
// ============================================================
router.post(
  "/reset-user-password",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const { user_id } = req.body;
      if (!user_id)
        return res
          .status(400)
          .json({ success: false, error: "User ID wajib diisi" });

      const user = await dbGet(
        "SELECT id, email, COALESCE(full_name, username, email) AS name FROM users WHERE id = ?", // V9.26.0: Fix name column
        [user_id],
      );
      if (!user)
        return res
          .status(404)
          .json({ success: false, error: "User tidak ditemukan" });

      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
      const crypto = require("crypto");
      let tempPassword = "";
      for (let i = 0; i < 8; i++) {
        tempPassword += chars.charAt(crypto.randomInt(0, chars.length));
      }

      const bcrypt = require("bcryptjs");
      const hash = await bcrypt.hash(tempPassword, 10);

      await dbRun("UPDATE users SET password_hash = ? WHERE id = ?", [
        hash,
        user_id,
      ]);

      logger.info("Password user direset oleh admin", {
        adminId: req.user.id,
        userId: user_id,
        email: user.email,
      });

      res.json({
        success: true,
        temp_password: tempPassword,
        user: { id: user.id, email: user.email, name: user.name },
      });
    } catch (err) {
      logger.error("Reset password error", { error: err.message });
      res.status(500).json({
        success: false,
        error: "Gagal reset password: " + err.message,
      });
    }
  },
);

module.exports = router;
