-- ════════════════════════════════════════════════════════════════
--  精读 LexiRead · 跨设备同步表结构
--  用法：Supabase 控制台 → 左侧 SQL Editor → New query → 全部粘贴 → Run
--  这个脚本可以重复执行，不会报错。
-- ════════════════════════════════════════════════════════════════

-- ── 文章（元数据，不含正文） ──
create table if not exists public.lexi_articles (
  user_id     uuid    not null references auth.users(id) on delete cascade,
  id          text    not null,
  title       text    default '',
  word_count  int     default 0,
  progress    real    default 0,
  created     bigint  default 0,
  last_read   bigint  default 0,
  updated     bigint  not null default 0,
  deleted     boolean not null default false,
  primary key (user_id, id)
);

-- ── 文章正文（单独一张表，读列表时不用把它拉下来） ──
create table if not exists public.lexi_bodies (
  user_id  uuid   not null references auth.users(id) on delete cascade,
  id       text   not null,
  raw      text   default '',
  updated  bigint not null default 0,
  primary key (user_id, id)
);

-- ── 生词本（含间隔重复状态与收录时的原句） ──
create table if not exists public.lexi_vocab (
  user_id  uuid    not null references auth.users(id) on delete cascade,
  word     text    not null,
  data     jsonb   not null,
  updated  bigint  not null default 0,
  deleted  boolean not null default false,
  primary key (user_id, word)
);

-- ── AI 讲解缓存（同步过去可以省两遍钱） ──
create table if not exists public.lexi_aica (
  user_id  uuid   not null references auth.users(id) on delete cascade,
  k        text   not null,
  text     text   default '',
  updated  bigint not null default 0,
  primary key (user_id, k)
);

-- ── 阅读排版等设置 ──
create table if not exists public.lexi_settings (
  user_id  uuid   primary key references auth.users(id) on delete cascade,
  data     jsonb  not null,
  updated  bigint not null default 0
);

-- ── 打开行级安全，并只允许本人读写自己的数据 ──
alter table public.lexi_articles enable row level security;
alter table public.lexi_bodies   enable row level security;
alter table public.lexi_vocab    enable row level security;
alter table public.lexi_aica     enable row level security;
alter table public.lexi_settings enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['lexi_articles','lexi_bodies','lexi_vocab','lexi_aica','lexi_settings']
  loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated '
      'using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
  end loop;
end $$;

-- ── 让同步更快 ──
create index if not exists lexi_articles_user_updated on public.lexi_articles (user_id, updated);
create index if not exists lexi_bodies_user_updated   on public.lexi_bodies   (user_id, updated);
create index if not exists lexi_vocab_user_updated    on public.lexi_vocab    (user_id, updated);
create index if not exists lexi_aica_user_updated     on public.lexi_aica     (user_id, updated);
