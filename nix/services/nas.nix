{ config, pkgs, ... }:

{
  services.avahi = {
    enable = true;
    openFirewall = true;
    nssmdns4 = true;
    publish = {
      enable = true;
      addresses = true;
      domain = true;
      hinfo = true;
      userServices = true;
    };

    extraServiceFiles = {
      smb = ''
        <?xml version="1.0" standalone='no'?><!--*-nxml-*-->
        <!DOCTYPE service-group SYSTEM "avahi-service.dtd">
        <service-group>
         <name replace-wildcards="yes">%h</name>
         <service>
          <type>_adisk._tcp</type>
          <txt-record>sys=waMa=0,adVF=0x100</txt-record>
          <txt-record>dk0=adVN=Time Capsule,adVF=0x82</txt-record>
         </service>
         <service>
          <type>_smb._tcp</type>
          <port>445</port>
         </service>
        </service-group>
      '';
    };
  };

  services.samba = {
    enable = true;
    securityType = "user";
    openFirewall = true;
    extraConfig = ''
      workgroup = WORKGROUP
      server string = NixOS Samba Server
      server role = standalone server
      server services = -dns, -nbt
      server signing = default
      server multi channel support = yes

      hosts allow = 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16

      security = user
      guest account = nobody
      pam password change = yes
      map to guest = bad user
      usershare allow guests = yes

      create mask = 0664
      force create mode = 0664
      directory mask = 0775
      force directory mode = 0775
      follow symlinks = yes
      wide links = yes
      unix extensions = no

      load printers = no
      printing = bsd
      printcap name = /dev/null
      disable spoolss = yes


      strict locking = no
      aio read size = 0
      aio write size = 0
      vfs objects = acl_xattr catia fruit streams_xattr
      inherit permissions = yes

      client ipc max protocol = SMB3
      client ipc min protocol = SMB2_10
      client max protocol = SMB3
      client min protocol = SMB2_10
      server max protocol = SMB3
      server min protocol = SMB2_10

      disable netbios = yes
      smb ports = 445
      dns proxy = no
      socket options = TCP_NODELAY
      strict locking = no
      local master = no

      winbind scan trusted domains = yes
      # Time Machine
      vfs objects = fruit streams_xattr
      fruit:metadata = stream
      fruit:model = MacSamba
      fruit:posix_rename = yes
      fruit:veto_appledouble = no
      fruit:wipe_intentionally_left_blank_rfork = yes
      fruit:delete_empty_adfiles = yes
      fruit:time machine = yes
    '';

    shares = {
      "Time Capsule" = {
        path = "/storage/samba/timemachine";
        browseable = "no";
        "read only" = "no";
        "inherit acls" = "yes";
        "guest ok" = "yes";
        "force user" = "nobody";
        "force group" = "nogroup";
      };
      public = {
        path = "/storage/samba/public";
        browseable = "yes";
        "guest ok" = "yes";
        "read only" = "no";
        "force user" = "nobody";
        "force group" = "users";

        "veto files" =
          "/._*/.apdisk/.AppleDouble/.DS_Store/.TemporaryItems/.Trashes/desktop.ini/ehthumbs.db/Network Trash Folder/Temporary Items/Thumbs.db/";
        "delete veto files" = "yes";
      };
    };
  };
}
