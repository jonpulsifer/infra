{ config, lib, pkgs, ... }:
let
  inherit (lib) mkIf;
  inherit (pkgs) fetchFromGitHub;
  shellIntegration = config.programs.zsh.enable;
  k8s-workflow-utils = fetchFromGitHub {
    owner = "jonpulsifer";
    repo = "k8s-workflow-utils";
    rev = "c013d43763750321fdcd5fcdd8e152f62ff17dc7";
    sha256 = "sha256-cHQuVfnewEeoUBPB+mz2CVRhRE0xldAsZf/5yLf5Btg=";
  };
in
{
  home = {
    packages = with pkgs; [
      argocd
      cilium-cli
      fluxcd
      grafana-loki
      k6
      k8sgpt
      k9s
      kubectl
      kubecolor
      kubernetes-helm
    ];
    sessionPath = mkIf shellIntegration [ "${k8s-workflow-utils}/kubectl-plugins" ];
    sessionVariables = {
      KUBECONFIG = "${config.home.homeDirectory}/.kube/config";
    };
    shellAliases = rec {
      chctx = "kubectl ctx";
      chns = "kubectl ns";
      kube = "${pkgs.kubecolor}/bin/kubecolor";
      k = kube;
    };
  };
  programs.zsh = mkIf shellIntegration {
    sessionVariables = {
      KUBE_PS1_PREFIX = '''';
      KUBE_PS1_SUFFIX = '''';
      KUBE_PS1_SEPARATOR = '''';
      KUBE_PS1_SYMBOL_PADDING = "true";
    };
    initExtra = ''
      export RPS1='$(kube_ps1)'
      logs() {
        FZF_DEFAULT_COMMAND="kubectl get pods --all-namespaces" \
          fzf --info=inline --layout=reverse --header-lines=1 \
            --prompt "$(kubectl config current-context | sed 's/-context$//')> " \
            --header $'╱ Enter (kubectl exec) ╱ CTRL-O (open log in editor) ╱ CTRL-R (reload) ╱\n\n' \
            --bind 'ctrl-/:change-preview-window(80%,border-bottom|hidden|)' \
            --bind 'enter:execute:kubectl exec -it --namespace {1} {2} -- /bin/sh > /dev/tty' \
            --bind 'ctrl-o:execute:''${EDITOR:-vim} <(kubectl logs --all-containers --namespace {1} {2}) > /dev/tty' \
            --bind 'ctrl-r:reload:kubectl get pods --all-namespaces' \
            --preview-window up:follow \
            --preview 'kubectl logs --follow --all-containers --tail=10000 --namespace {1} {2}' "$@"
      }
    '';
    plugins = [
      {
        name = "kube-ps1";
        file = "kube-ps1.sh";
        src = fetchFromGitHub {
          owner = "jonmosco";
          repo = "kube-ps1";
          rev = "v0.8.0";
          sha256 = "sha256-gOJ6XsFHbEZK+147gFUo7Nv6S4zLGPSvF6WYpO6QxLg=";
        };
      }
      {
        name = "k8s-workflow-utils";
        src = k8s-workflow-utils;
      }
      {
        name = "k8s-workflow-utils/completions";
        src = k8s-workflow-utils;
      }
    ];
  };
}
