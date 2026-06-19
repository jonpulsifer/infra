ARCH=amd64
BUILD_DIR=build
KERNEL_VERSION=5.4.15
KERNEL_VERSION_BUILD=2
KERNEL_MAJOR_VERSION=$(word 1, $(subst ., ,$(KERNEL_VERSION)))
KERNEL_MINOR_VERSION=$(word 2, $(subst ., ,$(KERNEL_VERSION)))
KERNEL_PATCH_VERSION=$(word 3, $(subst ., ,$(KERNEL_VERSION)))
KERNEL_LOCAL_VERSION=-cloudlab
UBUNTU_CODENAME=focal

.EXPORT_ALL_VARS:

.PHONY: all
all: help

.PHONY: kernel
kernel: check-latest verify-kernel genkconf build-kernel ## Downloads, verifies, configures, and starts a kernel build

.PHONY: verify-kernel
# "ABAF 11C6 5A29 70B1 30AB  E3C4 79BE 3E43 0041 1886" Linus
# "647F 2865 4894 E3BD 4571  99BE 38DB BDC8 6092 693E" Greg
verify-kernel: ## Downloads and verifies $(KERNEL_VERSION)
	gpg2 --keyserver hkp://keys.gnupg.org --locate-keys torvalds@kernel.org gregkh@kernel.org

	mkdir -p $(BUILD_DIR) && cd $(BUILD_DIR) && \
	wget -q --no-clobber https://cdn.kernel.org/pub/linux/kernel/v$(KERNEL_MAJOR_VERSION).x/linux-$(KERNEL_VERSION).tar.xz && \
	wget -q --no-clobber https://cdn.kernel.org/pub/linux/kernel/v$(KERNEL_MAJOR_VERSION).x/linux-$(KERNEL_VERSION).tar.sign && \
	unxz -c linux-$(KERNEL_VERSION).tar.xz | gpg -q --verify linux-$(KERNEL_VERSION).tar.sign - && \
	tar -xaf linux-$(KERNEL_VERSION).tar.xz

.PHONY: genkconf
genkconf: ## copies a kconfig from /boot into the build dir and makes olddefconfig
	cd $(BUILD_DIR)/linux-$(KERNEL_VERSION) && \
	cp -v /boot/config-$(shell uname -r) .config && \
	make olddefconfig

.PHONY: build-kernel
build-kernel: ## Builds .debs of the kernel
	cd $(BUILD_DIR) && \
	make -j$(shell getconf _NPROCESSORS_ONLN) -C linux-$(KERNEL_VERSION)/ bindeb-pkg LOCALVERSION=$(KERNEL_LOCALVERSION)

.PHONY: check-latest
check-latest: ## Checks kernel.org for the latest stable version
	$(eval version=$(shell wget -q -O- https://kernel.org/finger_banner | awk '/latest stable version/ { print $$NF }'))
	@if [ $(version) = $(KERNEL_VERSION) ]; then \
		echo "You are on the latest version: $(KERNEL_VERSION)"; \
	else \
		echo "There is a newer version of the kernel available: $(version)"; \
	fi

.PHONY: download-ubuntu
download-ubuntu: ## Downloads Ubuntu (Focal) source
	mkdir -p $(BUILD_DIR)
	git clone git://git.launchpad.net/~ubuntu-kernel/ubuntu/+source/linux/+git/$(UBUNTU_CODENAME) $(BUILD_DIR)/ubuntu-$(UBUNTU_CODENAME)

.PHONY: clean
clean: ## Remove build artifacts
	rm -r $(BUILD_DIR)

.PHONY: help
help: ## ty jessfraz
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'
