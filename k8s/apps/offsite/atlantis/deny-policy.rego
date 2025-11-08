package main

# This is a "deny all" policy.
# The body just assigns a message, so it always succeeds and always denies.
deny contains msg if {
    msg := "Default deny policy: All actions are denied."
}