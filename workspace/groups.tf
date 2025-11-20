resource "googleworkspace_group" "cloud" {
  email       = "cloud@pulsifer.ca"
  name        = "cloud@pulsifer.ca"
  description = "Group that gives access to Google Cloud for pulsifer.ca"
}

resource "googleworkspace_group_members" "cloud" {
  group_id = googleworkspace_group.cloud.id

  members {
    email = "jonathan@pulsifer.ca"
    role  = "OWNER"
  }

  members {
    email = "jonathan@moonpay.com"
    role  = "MEMBER"
  }

  members {
    email             = "terraform@homelab-ng.iam.gserviceaccount.com"
    role              = "MEMBER"
    delivery_settings = "NONE"
  }
}

resource "googleworkspace_group_settings" "cloud" {
  email = googleworkspace_group.cloud.email

  allow_external_members         = true
  allow_web_posting              = false
  archive_only                   = false
  enable_collaborative_inbox     = false
  include_custom_footer          = false
  include_in_global_address_list = true
  is_archived                    = true
  members_can_post_as_the_group  = false
  message_moderation_level       = "MODERATE_NONE"
  primary_language               = "en"
  reply_to                       = "REPLY_TO_IGNORE"
  send_message_deny_notification = false
  spam_moderation_level          = "MODERATE"
  who_can_assist_content         = "OWNERS_ONLY"
  who_can_contact_owner          = "ALL_OWNERS_CAN_CONTACT"
  who_can_discover_group         = "ALL_MEMBERS_CAN_DISCOVER"
  who_can_join                   = "INVITED_CAN_JOIN"
  who_can_leave_group            = "NONE_CAN_LEAVE"
  who_can_moderate_content       = "OWNERS_ONLY"
  who_can_moderate_members       = "OWNERS_ONLY"
  who_can_post_message           = "ANYONE_CAN_POST"
  who_can_view_group             = "ALL_OWNERS_CAN_VIEW"
  who_can_view_membership        = "ALL_OWNERS_CAN_VIEW"
}
