/* ─────────────────────────────────────────────────────────────
   精读 LexiRead · 部署配置
   这里填的是 Supabase 的公开信息（Project URL 与 Publishable key），
   它们本来就设计成可以放在前端：数据安全靠的是数据库里的
   行级安全策略（RLS），别人拿到这两个值也读不到任何数据。
   千万不要把 secret key / service_role key 或任何 AI API Key 写在这里。
   ───────────────────────────────────────────────────────────── */
window.LEXIREAD_CONFIG = {
  supabaseUrl:     'https://ttuxougtjmvspiadpknb.supabase.co',
  supabaseAnonKey: 'sb_publishable_PWsmyZQgiBGv947HWqARog_5rCucrET',
};
