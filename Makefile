.PHONY: install fmt lint test ci clean

node_modules: package.json
	npm install

install: node_modules

fmt: node_modules
	npm run fmt

lint:
	npm run lint

test:
	npm run test

ci: lint test

clean:
	@echo "No build artifacts to clean"
