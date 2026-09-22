SELECT id, status, total_cents, currency, created_at
FROM orders
WHERE buyer_id = 7
  AND created_at >= now() - interval '90 days'
  AND created_at <  now() - interval '30 days'
ORDER BY created_at DESC
LIMIT 50
