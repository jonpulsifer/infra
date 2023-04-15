;;; init.el --- my init.el
;;; Commentary:
;;; Code:

;; (setq debug-on-error t)
(setq gc-cons-threshold (* 1024 1024 256)) ;; 256 MB

(require 'package)
(add-to-list 'package-archives '("melpa" . "https://melpa.org/packages/") t)

(setq package-enable-at-startup nil)
(package-initialize)

;; bootstrap `use-package'
(unless (package-installed-p 'use-package)
  (package-refresh-contents)
  (package-install 'use-package))
(eval-when-compile (add-to-list 'load-path "~/.emacs.d/lisp")
		   (require 'use-package))
(setq use-package-always-ensure t)

;; keep customizations out of init.el
(setq custom-file (concat user-emacs-directory "custom.el"))
(if (file-exists-p custom-file)
    (load custom-file))

;; whoami
(setq user-full-name "Jonathan Pulsifer" user-mail-address "jonathan@pulsifer.ca")

(defun jp/startup ()
  "See how long Emacs takes to load."
  (message "Emacs loaded in %s with %d garbos" (emacs-init-time) gcs-done))
(add-hook 'emacs-startup-hook #'jp/startup)


(defun jp/term ()
  "Split window and open a terminal."
  (interactive)
  (let* ((term-buffer-name "jterm")
	 (term-buffer-a (concat "*" term-buffer-name "*"))
	 (term-buffer (get-buffer term-buffer-a)))
    (if term-buffer
	(if (eq (current-buffer) term-buffer)
	    (progn
	      (other-window 1)
	      (delete-other-windows))
	  (split-window-below)
	  (other-window 1)
	  (switch-to-buffer term-buffer))
      (ansi-term "zsh" term-buffer-name))))

;; start emacs daemon
;; (server-start)

(set-frame-font "FiraCode Nerd Font 14" nil t)

(tool-bar-mode -1)
(xterm-mouse-mode 1)
(unless window-system
  (global-set-key (kbd "<mouse-4>") 'scroll-down-line)
  (global-set-key (kbd "<mouse-5>") 'scroll-up-line))

(global-set-key (kbd "C--") #'text-scale-decrease)
(global-set-key (kbd "C-=") #'text-scale-increase)
(global-set-key (kbd "C-x C-b") 'ibuffer)
(global-set-key (kbd "C-`") #'jp/term)

(global-prettify-symbols-mode +1)
(global-hl-line-mode 1)
(global-display-line-numbers-mode)

(setq default-directory (getenv "HOME"))
;; (add-to-list 'exec-path (concat (getenv "HOME") "/.nix-profile/bin"))

(let ((auto-save-dir (concat user-emacs-directory "autosave/"))
      (backup-dir (concat user-emacs-directory "backups/")))
  (if (not (file-directory-p auto-save-dir))
      (make-directory auto-save-dir t))
  (setq auto-save-file-name-transforms `((".*" ,auto-save-dir t)))
  (setq backup-directory-alist `(("." . ,backup-dir))))

(defun is-mac-p ()
  "This is a MacOS device."
  (eq system-type 'darwin))

(defun is-linux-p ()
  "This is a Linux device."
  (eq system-type 'gnu/linux))

(when (is-mac-p)
 (setq mac-option-modifier 'super
       mac-command-modifier 'meta))

(use-package
  rainbow-delimiters
  :hook (prog-mode . rainbow-delimiters-mode))

(use-package
  rainbow-mode
  :hook (prog-mode . rainbow-mode))

(use-package
  exec-path-from-shell
  :if (is-mac-p)
  :init (exec-path-from-shell-initialize))

(use-package
  helpful
  :bind (("C-h f" . helpful-callable)
	 ("C-h v" . helpful-variable)
	 ("C-h k" . helpful-key)
	 ("C-c C-d" . helpful-at-point)))

(use-package
  yasnippet
  :diminish (yas-minor-mode . "")
  :hook (after-init . yas-global-mode))

(use-package
  yasnippet-snippets
  :after yasnippet)

(use-package
  flycheck
  :init (global-flycheck-mode))

(use-package
  all-the-icons
  :if (display-graphic-p))
  ;; :config (all-the-icons-install-fonts))

(use-package all-the-icons-ibuffer
  :if (display-graphic-p)
  :requires (all-the-icons)
  :init (all-the-icons-ibuffer-mode 1))

(use-package treemacs
  :defer t
  :init
  (with-eval-after-load 'winum
    (define-key winum-keymap (kbd "M-0") #'treemacs-select-window))
  :config
  (progn
    (setq treemacs-litter-directories              '("/node_modules" "/.venv" "/.cask")
          treemacs-show-hidden-files               t
          treemacs-silent-filewatch                t
          treemacs-silent-refresh                  t)

    ;; The default width and height of the icons is 22 pixels. If you are
    ;; using a Hi-DPI display, uncomment this to double the icon size.
    ;; (treemacs-resize-icons 44)

    (treemacs-follow-mode t)
    (treemacs-filewatch-mode t)
    (treemacs-fringe-indicator-mode 'always))
  :bind
  (:map global-map
        ("M-0"       . treemacs-select-window)
        ("C-x t 1"   . treemacs-delete-other-windows)
        ("C-x t t"   . treemacs)
        ("C-x t d"   . treemacs-select-directory)
        ("C-x t B"   . treemacs-bookmark)
        ("C-x t C-t" . treemacs-find-file)
        ("C-x t M-t" . treemacs-find-tag)))

(use-package treemacs-all-the-icons
  :after (treemacs all-the-icons))

(use-package treemacs-projectile
  :after (treemacs projectile))

(use-package treemacs-icons-dired
  :hook (dired-mode . treemacs-icons-dired-enable-once))

(use-package treemacs-magit
  :after (treemacs magit))

(use-package doom-themes
  :config
  ;; Global settings (defaults)
  (setq doom-themes-enable-bold t    ; if nil, bold is universally disabled
        doom-themes-enable-italic t) ; if nil, italics is universally disabled
  (load-theme 'doom-vibrant t)

  ;; Enable flashing mode-line on errors
  (doom-themes-visual-bell-config)
  ;; Enable custom neotree theme (all-the-icons must be installed!)
  ;; (doom-themes-neotree-config)
  ;; or for treemacs users
  (setq doom-themes-treemacs-theme "doom-colors") ; use "doom-colors" for less minimal icon theme
  (doom-themes-treemacs-config)
  ;; Corrects (and improves) org-mode's native fontification.
  (doom-themes-org-config))

(use-package
  doom-modeline
  :init (doom-modeline-mode 1))

(use-package lsp-mode
  :hook ((lsp-mode . lsp-enable-which-key-integration)
         (go-mode . lsp-deferred)
         (nix-mode . lsp-deferred))
  :commands (lsp lsp-deferred)
  :init
  (setq lsp-keymap-prefix "C-c s"))

(use-package helm
  :defer nil
  :diminish helm-mode
  :bind (("C-x c" . helm-command-prefix-key)
         ("C-c i" . helm-imenu)
         ("C-c m" . helm-all-mark-rings)
         ("C-x b" . helm-mini)
         ("C-c r" . helm-regexp)
         ("C-x C-f" . helm-find-files)
         ("M-x" . helm-M-x)
         ("M-y" . helm-show-kill-ring))
  :config
  (helm-mode t))

(use-package helm-ag
  :bind ("C-c g" . helm-projectile-ag))

(use-package helm-atoms
  :defer t)

(use-package helm-descbinds)

(use-package helm-lsp
  :after (helm lsp-mode))

(use-package helm-projectile
  :after (helm projectile))

(use-package helm-system-packages
  :defer t)

(use-package helm-tramp
  :commands (helm-tramp))

(use-package
  diminish)

(use-package
  projectile
  :after helm
  :config (setq projectile-completion-system 'helm projectile-mode-line-prefix " Pro")
  (projectile-mode 1))

(use-package
  page-break-lines
  :config (global-page-break-lines-mode))

(use-package
  dashboard
  :requires (page-break-lines projectile)
  :hook (after-init . dashboard-refresh-buffer)
  :config (setq dashboard-startup-banner "~/.dotfiles/glamanon.jpeg")
  (setq dashboard-center-content t)
  (setq dashboard-projects-backend 'projectile)
  (setq dashboard-set-heading-icons t)
  (setq dashboard-set-file-icons t)
  (setq dashboard-set-navigator t)
  (setq dashboard-items '((agenda    . 5)
			  (projects . 5)
			  (recents   . 10)))
  (dashboard-setup-startup-hook))

(use-package
  which-key
  :defer t
  :hook (after-init . which-key-mode)
  :init (which-key-setup-side-window-right-bottom))

;; whitespace
(use-package
  ws-trim
  :defer t
  :load-path "lisp/")

(use-package
  ws-butler
  :defer t
  :hook (prog-mode . ws-butler-mode))
(setq-default show-trailing-whitespace nil)

;; completion
(use-package
  company
  :requires (yasnippet)
  :config (setq company-show-numbers t)
  (setq company-tooltip-align-annotations t)
  (setq company-tooltip-flip-when-above t)
  (setq company-idle-delay 0.1)
  (setq company-show-numbers t)
  (setq company-minimum-prefix-length 1)
  (setq company-dabbrev-downcase nil)
  (setq company-dabbrev-other-buffers t)
  (setq company-auto-complete t)
  (setq company-dabbrev-code-other-buffers 'all)
  (setq company-dabbrev-code-everywhere t)
  (setq company-dabbrev-code-ignore-case t)
  (global-company-mode t))

(use-package
  company-quickhelp
  :if (display-graphic-p)
  :init (use-package
	  pos-tip)
  :config (company-quickhelp-mode))

(use-package company-box
  :if (display-graphic-p)
  :hook (company-mode . company-box-mode))

;; languages
(use-package
  go-mode)

(use-package
  nix-mode
  :mode "\\.nix$")

(use-package
  terraform-mode
  :hook (terraform-mode . #'terraform-format-on-save-mode))

(use-package
  yaml-mode
  :mode "\\.ya?ml$")

;; web
(use-package
  web-mode
  :mode (("\\.html?\\'" . web-mode)
	 ("\\.tsx?\\'" . web-mode)
	 ("\\.jsx?\\'" . web-mode))
  :config (setq web-mode-markup-indent-offset 2 web-mode-css-indent-offset 2
		web-mode-code-indent-offset 2 web-mode-block-padding 2 web-mode-comment-style 2
		web-mode-enable-css-colorization t web-mode-enable-auto-pairing t
		web-mode-enable-comment-keywords t web-mode-enable-current-element-highlight t)
  (add-hook 'web-mode-hook
	    (lambda ()
	      (when (string-equal "tsx" (file-name-extension buffer-file-name))
		(setup-tide-mode))))
  (flycheck-add-mode 'typescript-tslint 'web-mode))

(use-package
  typescript-mode
  :config (setq typescript-indent-level 2)
  (add-hook 'typescript-mode-hook #'setup-tide-mode))

(use-package
  js2-mode
  :config (setq js-indent-level 2))

(use-package
  json-mode
  :mode "\\.json$'")

(use-package
  rjsx-mode
  :mode "\\.jsx$"
  :hook (rjsx-mode . #'setup-tide-mode))

(defun setup-tide-mode ()
  "Set up tide."
  (interactive)
  (tide-setup)
  (flycheck-mode +1)
  (setq flycheck-check-syntax-automatically '(save mode-enabled))
  (eldoc-mode +1)
  (tide-hl-identifier-mode +1)
  (company-mode +1))

(use-package
  tide
  :after (typescript-mode company flycheck)
  :hook ((typescript-mode . tide-setup)
        (typescript-mode . tide-hl-identifier-mode)
        (before-save . tide-format-before-save)))

(use-package prettier-js
  :hook (web-mode . prettier-js-mode))

;; ruby
(use-package robe
  :after company
  :hook (ruby-mode . robe-mode)
  :config
  (push 'company-robe company-backends))

(use-package rubocop
  :hook (ruby-mode . rubocop-mode)
  :config (setq rubocop-autocorrect-on-save t)
  :diminish rubocop-mode)

(use-package
  deadgrep)
(global-set-key (kbd "<f5>") #'deadgrep)

(use-package
  magit)
(use-package forge
  :after magit)

(use-package
  docker
  :bind ("C-c d" . docker))

(use-package
  dockerfile-mode
  :mode "Dockerfile")

(use-package
  kubernetes
  :commands (kubernetes-overview))

(use-package
  emojify
  :hook (after-init . global-emojify-mode))

(use-package
  nyan-mode
  :if (display-graphic-p)
  :custom (setq nyan-animate-nyancat nil)
  (setq nyan-wavy-trail t)
  :config
  (nyan-mode 1))

(provide 'init)
;;; init.el ends here
