SELECT id, buyer_id, total_cents, currency, created_at
FROM orders
WHERE status = 'pending'
ORDER BY created_at DESC
LIMIT 100
