{ config, pkgs, ... }:
{
  programs.vscode = {
    enable = true;
    mutableExtensionsDir = true;
    userSettings =
      let fontSize = 18;
      in {
        "editor.autoClosingBrackets" = "never";
        "editor.autoClosingQuotes" = "never";
        "editor.fontFamily" = "FiraCode Nerd Font";
        "editor.fontLigatures" = true;
        "editor.fontSize" = fontSize;
        "editor.formatOnSave" = true;
        "editor.inlineSuggest.enabled" = true;
        "editor.suggestOnTriggerCharacters" = false;
        "editor.tabSize" = 2;
        "files.insertFinalNewline" = true;
        "files.trimFinalNewlines" = true;
        "github.copilot.enable" = {
          "*" = true;
          "yaml" = true;
          "plaintext" = true;
          "markdown" = true;
        };
        "go.survey.prompt" = false;
        "nixfmt.path" = "nix fmt";
        "redhat.telemetry.enabled" = false;
        "telemetry.telemetryLevel" = "off";
        "terminal.integrated.fontSize" = fontSize;
        "terraform.experimentalFeatures.validateOnSave" = true;
        "vs-kubernetes" = {
          "vscode-kubernetes.helm-path" = "${pkgs.kubernetes-helm}/bin/helm";
        };
        "window.zoomLevel" = 0;
        "workbench.colorTheme" = "Material Theme Ocean";
        "workbench.iconTheme" = "material-icon-theme";
        "workbench.productIconTheme" = "material-product-icons";
        "[nix]" = {
          "editor.defaultFormatter" = "jnoortheen.nix-ide";
        };
        "[html]" = {
          "editor.defaultFormatter" = "esbenp.prettier-vscode";
        };
        "[javascript]" = {
          "editor.defaultFormatter" = "esbenp.prettier-vscode";
        };
        "[typescript]" = {
          "editor.defaultFormatter" = "vscode.typescript-language-features";
        };
        "[typescriptreact]" = {
          "editor.defaultFormatter" = "esbenp.prettier-vscode";
        };
        "[yaml]" = { "editor.defaultFormatter" = "redhat.vscode-yaml"; };
      };
  };
}
