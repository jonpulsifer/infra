ARCH=amd64
BASE_URL=https://partner-images.canonical.com/core/lunar/current
BASE_PACKAGE=ubuntu-lunar-core-cloudimg-$(ARCH)
BASE_TARBALL=$(BASE_PACKAGE)-root.tar.gz
BUILD_DIR=build

REGISTRY=gcr.io
PROJECT=trusted-builds
IMAGE_NAME=ubuntu-2304-base
FULL_IMAGE_URL=$(REGISTRY)/$(PROJECT)/$(IMAGE_NAME)

# http://keyserver.ubuntu.com/pks/lookup?search=0xD2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81&op=vindex
# Type bits/keyID     cr. time   exp time   key expir
# pub  4096R/7DB87C81 2009-09-15
# uid UEC Image Automatic Signing Key <cdimage@ubuntu.com>
GPG_KEY=D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81

.PHONY: all
all: clean verify-baseimage build ## Download and verify the latest base image

.PHONY: update-baseimage
update-baseimage: clean verify-baseimage ## Updates the baseimage manifest and serial
	stat -c %y $(BUILD_DIR)/$(BASE_TARBALL) | awk '{print $$1}' | tr -d \- > $(CURDIR)/baseimage/current && \
	cp -v $(BUILD_DIR)/$(BASE_PACKAGE).manifest $(CURDIR)/baseimage

.PHONY: verify-baseimage
verify-baseimage: clean ## Download and verify the latest base image
	mkdir -p $(BUILD_DIR) && cd $(BUILD_DIR) && \
	for file in SHA256SUMS SHA256SUMS.gpg $(BASE_PACKAGE).manifest $(BASE_TARBALL); do \
		wget -qO $$file $(BASE_URL)/$$file ; \
	done && \
	gpg --keyserver keyserver.ubuntu.com --recv-keys $(GPG_KEY) && \
	gpg --batch --verify SHA256SUMS.gpg SHA256SUMS && \
	sha256sum --ignore-missing -c SHA256SUMS

.PHONY: push
push: clean verify-baseimage build ## Tag and push new Dockerfile
	docker tag $(FULL_IMAGE_URL) $(FULL_IMAGE_URL):$(RELEASE) && \
	docker push $(FULL_IMAGE_URL):$(RELEASE)

.PHONY: build-local
build-local: ## Build Docker container locally (assumes docker present)
	cp -v $(CURDIR)/images/$(IMAGE_NAME).Dockerfile $(BUILD_DIR)/Dockerfile && \
	docker build -t $(FULL_IMAGE_URL) $(BUILD_DIR)

.PHONY: clean
clean: ## Remove build artifacts
	if [ -d $(BUILD_DIR) ]; then rm  -v $(BUILD_DIR)/* && rmdir -v $(BUILD_DIR); else echo "$(BUILD_DIR) does not exist. Nothing to do."; fi

.PHONY: help
help: ## ty jessfraz
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'
