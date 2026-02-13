.PHONY: install build dev up down logs clean

install:
	pnpm install

build:
	pnpm build

dev: build
	docker compose up -d qdrant conduit
	pnpm dev

up:
	docker compose up -d --build

down:
	docker compose down

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
