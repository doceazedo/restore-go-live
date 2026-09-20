import { Patch } from "@utils/types";

type PluginPatch = Omit<Patch, "plugin">;

export const streamStartPatch: PluginPatch = {
  find: 'type:"STREAM_START"',
  replacement: {
    match: /(function (\i)\((\i),(\i),(\i)\)\{)(\i\.\i\.dispatch\(\{type:"STREAM_START")/,
    replace: "$1if($self.onStreamStart($3,$4,$5))return;$6"
  }
};

export const streamStopPatch: PluginPatch = {
  find: 'type:"STREAM_STOP"',
  replacement: {
    match: /(function (\i)\((\i)\)\{let .{0,200}?)(\i\.\i\.dispatch\(\{type:"STREAM_STOP")/,
    replace: "$1if($self.onStreamStop($3))return;$4"
  }
};

export const streamWatchPatch: PluginPatch = {
  find: 'type:"STREAM_WATCH"',
  replacement: {
    match: /(\i\.\i\.dispatch\(\{type:"STREAM_WATCH",streamKey:(\i))/,
    replace: "$self.onStreamWatch($2)?void 0:$1"
  }
};

export const videoSourcePatch: PluginPatch = {
  find: "attaching srcObject for ",
  replacement: {
    match: /let (\i)=(\(0,\i\.\i\)\((\i)\));return (\i)\.srcObject=\1\.stream/,
    replace: "let $1=$self.resolveStream($3,()=>$2);return $4.srcObject=$1.stream"
  }
};

export const streamTileEndedPatch: PluginPatch = {
  find: "Stream Tile State - activeStream:",
  replacement: {
    match: /(if\((\i)\?\.state===\i\.\i\.ENDED)\)/,
    replace: "$1&&!$self.isOurStream($2))"
  }
};

export const streamTileErrorPatch: PluginPatch = {
  find: "Stream Tile State - activeStream:",
  replacement: {
    match: /let (\i)=(\(0,\i\.\i\)\(\i\.x\.STREAM,(\i)\.user\.id\))/,
    replace: "let $1=$self.maskStreamError($3.user.id,$2)"
  }
};

export const browserVideoSourcePatch: PluginPatch = {
  find: "e.srcObject=",
  replacement: {
    match: /(\i)\.srcObject=(\(0,\i\.\i\)\((\i)\))(,\(\)=>\{)/,
    replace: "$1.srcObject=$self.resolveStreamRaw($3,()=>$2)$4"
  },
  noWarn: true
};
