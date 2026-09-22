SELECT id, buyer_id, total_amount, currency, created_at
FROM orders
WHERE status = 'pending'
ORDER BY created_at DESC
LIMIT 100
