ARCH=amd64
BASE_URL=https://partner-images.canonical.com/core/jammy/current
BASE_PACKAGE=ubuntu-jammy-core-cloudimg-$(ARCH)
BASE_TARBALL=$(BASE_PACKAGE)-root.tar.gz
BUILD_DIR=build

REGISTRY=gcr.io
PROJECT=trusted-builds
IMAGE_NAME=ubuntu-2204-base
FULL_IMAGE_URL=$(REGISTRY)/$(PROJECT)/$(IMAGE_NAME)

# http://keyserver.ubuntu.com/pks/lookup?search=0xD2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81&op=vindex
# Type bits/keyID     cr. time   exp time   key expir
# pub  4096R/7DB87C81 2009-09-15
# uid UEC Image Automatic Signing Key <cdimage@ubuntu.com>
UBUNTU_SIGNING_KEY=D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81

.PHONY: all
all: help

.PHONY: container
container: clean download-baseimage verify-baseimage update-baseimage ## Downloads, verifies, and updates the baseimage tarball

.PHONY: update-baseimage
update-baseimage: ## Updates the baseimage manifest and serial
	stat -c %y $(BUILD_DIR)/$(BASE_TARBALL) | awk '{print $$1}' | tr -d \- > $(CURDIR)/current && \
	cp -v $(BUILD_DIR)/$(BASE_PACKAGE).manifest $(CURDIR)

.PHONY: download-baseimage
download-baseimage: ## Download the latest base image
	mkdir -p $(BUILD_DIR)
	for file in SHA256SUMS SHA256SUMS.gpg $(BASE_PACKAGE).manifest $(BASE_TARBALL); do \
		wget -nv --no-clobber -O $(BUILD_DIR)/$$file $(BASE_URL)/$$file ; \
	done

.PHONY: verify-baseimage
verify-baseimage: ## Verifies the baseimage tarball signature
	gpg2 -q --keyserver hkps://keyserver.ubuntu.com --recv-keys $(UBUNTU_SIGNING_KEY)
	cd $(BUILD_DIR) && \
	gpg2 --batch --verify SHA256SUMS.gpg SHA256SUMS && \
	sha256sum --ignore-missing -c SHA256SUMS

.PHONY: push
push: verify-baseimage build-container ## Tag and push new Dockerfile
	docker tag $(FULL_IMAGE_URL) $(FULL_IMAGE_URL):$(RELEASE) && \
	docker push $(FULL_IMAGE_URL):$(RELEASE)

.PHONY: build
build: build-container

.PHONY: build-container
build-container: update-baseimage # Build Docker container locally
	cp -v Dockerfile $(BUILD_DIR)/Dockerfile && \
	docker build -t $(FULL_IMAGE_URL) $(BUILD_DIR)

.PHONY: clean
clean: ## Remove build artifacts
	if [ -d $(BUILD_DIR) ]; then rm -r $(BUILD_DIR); fi

.PHONY: help
help: ## ty jessfraz
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'
