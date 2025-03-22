final: prev: {
  # jre = prev.openjdk11;
  minecraft-server = prev.minecraft-server.overrideAttrs (old: rec {
    version = "1.19.3";
    src = prev.fetchurl {
      url = "https://piston-data.mojang.com/v1/objects/c9df48efed58511cdd0213c56b9013a7b5c9ac1f/server.jar";
      sha256 = "sha256-Tr060UJRKVPQGTrjodGjDIlpB958aHgJdxUfbMefHhs=";
    };
  });
}
