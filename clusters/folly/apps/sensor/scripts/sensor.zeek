##! The sensor's logging: every stream goes to stdout as one JSON object per
##! line, with the stream's name in _path, so the node's Vector agent ships
##! it as a pod log and VictoriaLogs stores it.

@load policy/protocols/conn/community-id-logging

redef LogAscii::use_json = T;
redef LogAscii::json_timestamps = JSON::TS_ISO8601;
redef LogAscii::output_to_stdout = T;
redef Log::default_rotation_interval = 0 secs;

type SensorExtension: record {
  path: string &log;
};

function sensor_extension(path: string): SensorExtension
  {
  return SensorExtension($path = path);
  }

redef Log::default_ext_func = sensor_extension;
redef Log::default_ext_prefix = "_";

# The private ranges are local; the gateway routes everything else.
redef Site::local_nets += { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 };
