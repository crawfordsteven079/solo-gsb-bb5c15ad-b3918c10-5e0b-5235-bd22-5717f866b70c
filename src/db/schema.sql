-- 纸质展品光照额度管理：数据库结构（幂等，可重复执行）

CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('conservator', 'installer')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exhibits (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  medium      TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 每件展品每个自然年的照度时数上限（lux·h）
CREATE TABLE IF NOT EXISTS annual_limits (
  id          SERIAL PRIMARY KEY,
  exhibit_id  INTEGER NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
  year        INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2999),
  max_dose    NUMERIC(14, 4) NOT NULL CHECK (max_dose > 0),
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (exhibit_id, year)
);

CREATE TABLE IF NOT EXISTS plans (
  id             SERIAL PRIMARY KEY,
  exhibit_id     INTEGER NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
  created_by     INTEGER REFERENCES users(id),
  start_date     DATE NOT NULL,
  end_date       DATE NOT NULL,
  lights_on      TIME NOT NULL,
  lights_off     TIME NOT NULL,
  estimated_lux  NUMERIC(10, 2) NOT NULL CHECK (estimated_lux > 0),
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected', 'pending_review')),
  review_reason  TEXT,
  approved_by    INTEGER REFERENCES users(id),
  approved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK (lights_off > lights_on)
);

CREATE INDEX IF NOT EXISTS idx_plans_exhibit_status ON plans(exhibit_id, status);
CREATE INDEX IF NOT EXISTS idx_plans_dates ON plans(start_date, end_date);

-- 已批准/待复核计划的“占用”计划，供审批时行级锁定，串行化同一展品上的并发审批
CREATE TABLE IF NOT EXISTS exhibit_lock (
  exhibit_id INTEGER PRIMARY KEY REFERENCES exhibits(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS measurements (
  id            SERIAL PRIMARY KEY,
  exhibit_id    INTEGER NOT NULL REFERENCES exhibits(id) ON DELETE CASCADE,
  plan_id       INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  measured_on   DATE NOT NULL,
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  actual_lux    NUMERIC(10, 2) NOT NULL CHECK (actual_lux > 0),
  status        TEXT NOT NULL DEFAULT 'recorded'
                  CHECK (status IN ('recorded', 'confirmed')),
  note          TEXT,
  created_by    INTEGER REFERENCES users(id),
  confirmed_by  INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at  TIMESTAMPTZ,
  CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_meas_exhibit_status ON measurements(exhibit_id, status);
CREATE INDEX IF NOT EXISTS idx_meas_plan ON measurements(plan_id);

-- express-session / connect-pg-simple 会话表
CREATE TABLE IF NOT EXISTS "session" (
  "sid"     varchar NOT NULL COLLATE "default",
  "sess"    json NOT NULL,
  "expire"  timestamp(6) NOT NULL
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
  ) THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid");
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
