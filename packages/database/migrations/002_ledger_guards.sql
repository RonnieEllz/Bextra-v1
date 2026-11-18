CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only ledger: % rows cannot be updated or deleted', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER transactions_immutable_update
BEFORE UPDATE OR DELETE ON transactions
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER ledger_entries_immutable_update
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE OR REPLACE FUNCTION check_transaction_balanced()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  debit_total BIGINT;
  credit_total BIGINT;
BEGIN
  SELECT COALESCE(SUM(debit_minor), 0), COALESCE(SUM(credit_minor), 0)
  INTO debit_total, credit_total
  FROM ledger_entries
  WHERE transaction_id = NEW.transaction_id;

  IF debit_total <> credit_total THEN
    RAISE EXCEPTION 'unbalanced transaction %: debits %, credits %',
      NEW.transaction_id, debit_total, credit_total;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_must_balance
AFTER INSERT OR UPDATE ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_transaction_balanced();
