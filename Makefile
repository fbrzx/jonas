.PHONY: install build typecheck dev up down logs clean rebuild smoke

install:
	pnpm install

build:
	pnpm build

typecheck:
	pnpm typecheck

dev: build
	docker compose up -d qdrant conduit
	pnpm dev

up:
	docker compose up -d --build

down:
	docker compose down

rebuild: build
	@echo "🔄 Rebuilding Jonas..."
	docker compose down
	docker compose up -d --build
	@echo "⏳ Waiting for services to start..."
	@sleep 5
	@echo "✅ Rebuild complete!"

smoke:
	@echo "🧪 Running smoke tests..."
	@./scripts/smoke-test.sh

logs:
	docker compose logs -f

clean:
	pnpm clean
	docker compose down -v

health:
	./scripts/health-check.sh

backup:
	./scripts/backup.sh

tunnel:
	./scripts/connect.sh
