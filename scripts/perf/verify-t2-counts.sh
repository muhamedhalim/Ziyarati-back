#!/bin/bash
# T068 — verify T2 achieved row counts against T018's targets.
docker exec ziyarati-perfaudit-postgres psql -U postgres -d ziyarati_perf_t2 -c "
SELECT 'tenants' t, count(*) achieved, 500 target FROM tenants
UNION ALL SELECT 'branches', count(*), 1200 FROM branches
UNION ALL SELECT 'users', count(*), 3000 FROM users WHERE \"tenantId\" IS NOT NULL
UNION ALL SELECT 'customers', count(*), 200000 FROM customers
UNION ALL SELECT 'appointments', count(*), 900000 FROM appointments
UNION ALL SELECT 'invoices', count(*), 600000 FROM invoices
UNION ALL SELECT 'payments', count(*), 600000 FROM payments
UNION ALL SELECT 'conversations', count(*), 300000 FROM conversations
UNION ALL SELECT 'messages', count(*), 2500000 FROM messages
ORDER BY 1;
"
