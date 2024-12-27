{ pkgs, lib, ... }: {
  nix = {
    # package = pkgs.nixFlakes;
    configureBuildUsers = true;
    optimise = {
      automatic = true;
    };
    settings = {
      trusted-users = [ "@admin" ];
      build-users-group = "nixbld";
      sandbox = true;
      experimental-features = "nix-command flakes";
      substituters = [
        # TODO: figure out a way to use this only when local to the nix cache, or split dns
        # "https://nix.lolwtf.ca"
        "https://cache.nixos.org"
        "https://nix-community.cachix.org"
        "https://jonpulsifer.cachix.org"
      ];
      trusted-public-keys = [
        "nix.lolwtf.ca:RVHS59kCG4aWsOjbQeFRnDKrCQzc2nHt8UJrBTm/e0Y="
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
        "jonpulsifer.cachix.org-1:Rwya0JXhlZXczd5v3JVBgY0pU5tUbiaqw5RfFdxBakQ="
      ];
    };
    extraOptions = lib.optionalString (pkgs.system == "aarch64-darwin") ''
      extra-platforms = x86_64-darwin aarch64-darwin
    '';
  };
  # time.timeZone = "America/Halifax";
  services.nix-daemon.enable = true;
  programs.zsh.enable = true;

  # TODO: replace with ghostty when available
  # environment.systemPackages = with pkgs [ alacritty ];

  fonts.packages = with pkgs.nerd-fonts; [ fira-code ];

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
  };

  users.users.jawn = {
    name = "jawn";
    home = "/Users/jawn";
    shell = pkgs.zsh;
    description = "Jonathan Pulsifer";
  };

  system.defaults.NSGlobalDomain.AppleInterfaceStyle = "Dark";
  system.defaults.NSGlobalDomain.AppleMeasurementUnits = "Centimeters";
  system.defaults.NSGlobalDomain.AppleMetricUnits = 1;
  system.defaults.NSGlobalDomain.AppleShowAllExtensions = true;
  system.defaults.NSGlobalDomain.AppleShowAllFiles = true;
  system.defaults.NSGlobalDomain.AppleTemperatureUnit = "Celsius";
  system.defaults.NSGlobalDomain.KeyRepeat = 1;

  system.defaults.NSGlobalDomain.NSAutomaticCapitalizationEnabled = false;
  system.defaults.NSGlobalDomain.NSAutomaticDashSubstitutionEnabled = false;
  system.defaults.NSGlobalDomain.NSAutomaticPeriodSubstitutionEnabled = false;
  system.defaults.NSGlobalDomain.NSAutomaticQuoteSubstitutionEnabled = false;
  system.defaults.NSGlobalDomain.NSAutomaticSpellingCorrectionEnabled = false;
  system.defaults.NSGlobalDomain.NSAutomaticWindowAnimationsEnabled = true;

  system.defaults.NSGlobalDomain."com.apple.swipescrolldirection" = false;

  system.defaults.dock.autohide = true;
  system.defaults.dock.autohide-delay = 0.0;
  system.defaults.dock.minimize-to-application = true;
  system.defaults.dock.mru-spaces = false;
  system.defaults.dock.orientation = "bottom";
  system.defaults.dock.show-process-indicators = true;
  system.defaults.dock.show-recents = false;
  system.defaults.dock.showhidden = true;
  system.defaults.dock.static-only = true;
  system.defaults.dock.tilesize = 64;

  system.defaults.finder.AppleShowAllExtensions = true;
  system.defaults.finder.AppleShowAllFiles = true;
  system.defaults.finder.QuitMenuItem = true;
  system.defaults.finder.ShowPathbar = true;
  system.defaults.finder.ShowStatusBar = true;

  system.defaults.trackpad.TrackpadRightClick = true;

  system.stateVersion = 4;
}
