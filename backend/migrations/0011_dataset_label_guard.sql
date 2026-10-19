-- Default table DML grants otherwise include these new columns. Guard both
-- inserts and updates in PostgreSQL, independently of API payload parsing.
CREATE OR REPLACE FUNCTION guard_dataset_label() RETURNS trigger AS $$
BEGIN
  IF current_user = 'velio_app' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.dataset <> 'real' THEN
        RAISE EXCEPTION 'dataset labels require the operator role' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NEW.dataset IS DISTINCT FROM OLD.dataset THEN
      RAISE EXCEPTION 'dataset labels require the operator role' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER users_dataset_operator BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION guard_dataset_label();
CREATE TRIGGER activities_dataset_operator BEFORE INSERT OR UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION guard_dataset_label();
