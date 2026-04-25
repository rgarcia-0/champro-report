CREATE TABLE IF NOT EXISTS orders (
    id               SERIAL PRIMARY KEY,
    order_num        VARCHAR(30)  NOT NULL UNIQUE,
    status           VARCHAR(150),
    id_type          VARCHAR(50),
    type             VARCHAR(50),
    due_date         DATE,
    sets             NUMERIC(10,1) DEFAULT 0,
    pieces           NUMERIC(10,1) DEFAULT 0,
    path             TEXT,
    designer         VARCHAR(100),
    qc               VARCHAR(100),
    sent_date        DATE,
    sku              VARCHAR(80),
    design           VARCHAR(150),
    ext_status       VARCHAR(30)  DEFAULT 'None',
    ext_by           VARCHAR(100),
    ext_date         VARCHAR(80),
    ext_line         VARCHAR(30),
    ext_reason       VARCHAR(400),
    ext_comment      TEXT,
    cpa_status       VARCHAR(150),
    last_cpa_check   TIMESTAMP,
    created_at       TIMESTAMP    DEFAULT NOW(),
    updated_at       TIMESTAMP    DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_orders_order_num  ON orders(order_num);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_ext_status ON orders(ext_status);
CREATE INDEX IF NOT EXISTS idx_orders_due_date   ON orders(due_date);

CREATE TABLE IF NOT EXISTS scraper_log (
    id               SERIAL PRIMARY KEY,
    run_type         VARCHAR(20)  NOT NULL,
    status           VARCHAR(20)  NOT NULL,
    started_at       TIMESTAMP    DEFAULT NOW(),
    finished_at      TIMESTAMP,
    orders_processed INTEGER      DEFAULT 0,
    orders_enriched  INTEGER      DEFAULT 0,
    error_message    TEXT,
    details          JSONB
  );

CREATE TABLE IF NOT EXISTS sync_log (
    id            SERIAL PRIMARY KEY,
    status        VARCHAR(20)  NOT NULL,
    started_at    TIMESTAMP    DEFAULT NOW(),
    finished_at   TIMESTAMP,
    rows_added    INTEGER      DEFAULT 0,
    rows_updated  INTEGER      DEFAULT 0,
    error_message TEXT
  );

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_updated_at ON orders;
CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
