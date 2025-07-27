# Stable overlay - Core system tools that don't need frequent updates
# These packages are less likely to cause rebuild churn
final: prev: {
  # Core shell utilities - these are stable and rarely change
  shell-utils = final.callPackage ../pkgs/shell-utils { };
}