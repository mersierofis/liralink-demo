.PHONY: install keys contract db dev reset check

NODE_WANT := $(shell cat .nvmrc)

define need_node
@node -v | grep -q "^v$(NODE_WANT)$$" || { echo "Node $(NODE_WANT) required: run 'nvm use' first"; exit 1; }
endef

install:
	$(need_node)
	cd backend && npm ci --no-fund --no-audit && npx prisma generate
	cd merchant-web && npm ci --no-fund --no-audit
	cd pay-web && npm ci --no-fund --no-audit

keys:
	./scripts/local/setup.sh

contract:
	./scripts/local/deploy-contract.sh

db:
	docker compose up -d --wait
	cd backend && npx prisma migrate deploy && npm run seed

dev:
	$(need_node)
	docker compose up -d --wait
	@trap 'kill 0' INT TERM EXIT; \
	(cd backend && npm run start:dev) & \
	(cd merchant-web && npm run dev) & \
	(cd pay-web && npm run dev) & \
	wait

# Drops the local database, re-applies all migrations and re-seeds (seed is wired in prisma7.config.ts).
reset:
	$(need_node)
	docker compose up -d --wait
	cd backend && npx prisma migrate reset --force

check:
	cd backend && npm run demo:check
