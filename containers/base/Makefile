ARCH=amd64
BASE_URL=https://partner-images.canonical.com/oci/jammy/current
BASE_PACKAGE=ubuntu-jammy-oci-$(ARCH)
BASE_TARBALL=$(BASE_PACKAGE)-root.tar.gz
BUILD_DIR=build

IMAGE_NAME=base
IMAGE_TAG=latest
GOOGLE_CLOUD_PROJECT=trusted-builds
GOOGLE_CLOUD_REGION=northamerica-northeast1
ARTIFACT_REGISTRY_REPOSITORY=i
REGISTRY=$(GOOGLE_CLOUD_REGION)-docker.pkg.dev
FULL_IMAGE_URL=$(REGISTRY)/$(GOOGLE_CLOUD_PROJECT)/$(ARTIFACT_REGISTRY_REPOSITORY)/$(IMAGE_NAME)

# http://keyserver.ubuntu.com/pks/lookup?search=0xD2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81&op=vindex
# Type bits/keyID     cr. time   exp time   key expir
# pub  4096R/7DB87C81 2009-09-15
# uid UEC Image Automatic Signing Key <cdimage@ubuntu.com>
UBUNTU_SIGNING_KEY=D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81

.PHONY: all
all: help

.PHONY: rootfs ## Downloads
rootfs: download-rootfs verify-rootfs update-serial ## Downloads, verifies, and updates the rootfs tarball

.PHONY: container
container: rootfs ## Build Docker container locally
	cp -v rootfs.Dockerfile $(BUILD_DIR)/Dockerfile && \
	docker build -t $(FULL_IMAGE_URL) $(BUILD_DIR)

.PHONY: update-serial
update-serial: ## Updates the rootfs serial
	cp -v $(BUILD_DIR)/$(BASE_PACKAGE).manifest $(BUILD_DIR)/current $(CURDIR)

.PHONY: download-rootfs
download-rootfs:
	mkdir $(BUILD_DIR)
	wget -nv --no-clobber -O $(BUILD_DIR)/current $(BASE_URL)/unpacked/build-info.txt
	for file in SHA256SUMS SHA256SUMS.gpg $(BASE_PACKAGE).manifest $(BASE_TARBALL); do \
		wget -nv --no-clobber -O $(BUILD_DIR)/$$file $(BASE_URL)/$$file ; \
	done

.PHONY: verify-rootfs
verify-rootfs:
	gpg2 -q --keyserver hkps://keyserver.ubuntu.com --recv-keys $(UBUNTU_SIGNING_KEY)
	cd $(BUILD_DIR) && \
	gpg2 --batch --verify SHA256SUMS.gpg SHA256SUMS && \
	shasum --ignore-missing -c SHA256SUMS

.PHONY: push
push: rootfs container
	docker tag $(FULL_IMAGE_URL) $(FULL_IMAGE_URL):$(IMAGE_TAG) && \
	docker push $(FULL_IMAGE_URL):$(IMAGE_TAG)

.PHONY: clean
clean: ## Remove build artifacts
	if [ -d $(BUILD_DIR) ]; then rm -r $(BUILD_DIR); fi

.PHONY: help
help: ## ty jessfraz
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'
