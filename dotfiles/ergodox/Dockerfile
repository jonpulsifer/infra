FROM qmkfm/base_container

WORKDIR /build
RUN git clone --recursive https://github.com/zsa/qmk_firmware/
COPY pandemic qmk_firmware/keyboards/ergodox_ez/keymaps/
CMD ["make", "-C", "qmk_firmware", "ergodox_ez/shine:pandemic"]
