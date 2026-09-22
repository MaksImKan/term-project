SELECT id, email, full_name, city, created_at
FROM users
WHERE lower(email) = lower('Sofiia.Shevchuk.31337@example.com')
