import re

with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\home_page.dart", "r", encoding="utf-8") as f:
    content = f.read()

# Build new params section
p = []
p.append('  Widget _params()=>Padding(padding:EdgeInsets.only(top:12),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[')
p.append('    _section("核心参数"),SizedBox(height:10),')
p.append('    _num("--n-gpu-layers","GPU 层数","加载到 GPU 的模型层数，-1=全部加载到显存",_cfg.nGpuLayers,(v)=>setState(()=>_cfg.nGpuLayers=v)),')
p.append('    _num("--ctx-size","上下文长度","模型最大上下文窗口，如 32768/128000",_cfg.contextSize,(v)=>setState(()=>_cfg.contextSize=v)),')
p.append('    _num("--batch-size","批处理大小","并行处理的 token 数量，影响吞吐量",_cfg.batchSize,(v)=>setState(()=>_cfg.batchSize=v)),')
p.append('    _num("--ubatch-size","微批处理","单次推理的最小批次，一般为 batch/4",_cfg.ubatchSize,(v)=>setState(()=>_cfg.ubatchSize=v)),')
p.append('    _num("--threads","CPU 线程数","推理使用的 CPU 线程，0=自动检测",_cfg.threads,(v)=>setState(()=>_cfg.threads=v)),')
p.append('    _num("--parallel","并行槽位","同时处理的最大并发请求数",_cfg.slots,(v)=>setState(()=>_cfg.slots=v)),')
p.append('    _num("--port","服务端口","llama-server HTTP 监听端口",_cfg.port,(v)=>setState(()=>_cfg.port=v)),')
p.append('    SizedBox(height:16), _section("缓存量化"),SizedBox(height:10),')
p.append('    _choice("--cache-type-k","K 缓存量化","Key 缓存的量化精度，q8_0 推荐",_cfg.cacheTypeK,["f16","q8_0","q4_0"],(v)=>setState(()=>_cfg.cacheTypeK=v)),')
p.append('    _choice("--cache-type-v","V 缓存量化","Value 缓存的量化精度，q8_0 推荐",_cfg.cacheTypeV,["f16","q8_0","q4_0"],(v)=>setState(()=>_cfg.cacheTypeV=v)),')
p.append('    SizedBox(height:16), _section("功能开关"),SizedBox(height:10),')
p.append('    _bool("--flash-attn","Flash Attention","启用 FA 加速推理，减少显存占用",_cfg.flashAttn,(v)=>setState(()=>_cfg.flashAttn=v)),')
p.append('    _bool("--mlock","内存锁定","锁定模型到物理内存，防止 swap 影响性能",_cfg.mlLock,(v)=>setState(()=>_cfg.mlLock=v)),')
p.append('    _bool("--cont-batching","连续批处理","动态合并请求，提高吞吐量",_cfg.contBatching,(v)=>setState(()=>_cfg.contBatching=v)),')
p.append('    _bool("--embeddings","嵌入模式","启用文本嵌入提取功能",_cfg.embeddings,(v)=>setState(()=>_cfg.embeddings=v)),')
p.append('    SizedBox(height:8),')
p.append('    ft.Expander(header:Text("高级参数",style:TextStyle(fontSize:12,color:Colors.grey[600])),content:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[')
p.append('      SizedBox(height:10),')
p.append('      _num("--rope-freq-base","RoPE 基础频率","位置编码基准频率，0=自动",_cfg.ropeFreqBase.toInt(),(v)=>setState(()=>_cfg.ropeFreqBase=v.toDouble())),')
p.append('      _num("--rope-freq-scale","RoPE 缩放","位置编码缩放因子，用于扩展上下文",_cfg.ropeFreqScale.toInt(),(v)=>setState(()=>_cfg.ropeFreqScale=v.toDouble())),')
p.append('      _num("--yarn-ext-factor","YaRN 扩展因子","NTK 感知外推的扩展系数",_cfg.yarnExtFactor.toInt(),(v)=>setState(()=>_cfg.yarnExtFactor=v.toDouble())),')
p.append('      _num("--yarn-attn-factor","YaRN 注意力因子","注意力分配的缩放比例",_cfg.yarnAttnFactor.toInt(),(v)=>setState(()=>_cfg.yarnAttnFactor=v.toDouble())),')
p.append('      _bool("--no-kv-offload","禁用 KV 卸载","强制 KV 缓存留在显存",_cfg.noKvOffload,(v)=>setState(()=>_cfg.noKvOffload=v)),')
p.append('      _bool("--no-mmap","禁用 mmap","不使用内存映射加载模型",_cfg.noMmap,(v)=>setState(()=>_cfg.noMmap=v)),')
p.append('      SizedBox(height:8),')
p.append('      _section("额外启动参数"),SizedBox(height:6),')
p.append('      SizedBox(width:400,child:ft.TextBox(placeholder:"其他 llama-server 命令行参数",onChanged:(v)=>_cfg.extraArgs=v)),')
p.append('    ]),initiallyExpanded:false),')
p.append('  ]));')
p.append('')
p.append('  Widget _num(String flag,String name,String desc,int value,Function(int) onChanged)=>Padding(padding:EdgeInsets.only(bottom:10),child:SizedBox(width:380,child:ft.Card(padding:EdgeInsets.all(10),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Row(children:[Text(flag,style:TextStyle(fontSize:11,fontFamily:"monospace",color:Color(0xFF0078D4))),SizedBox(width:8),Text(name,style:TextStyle(fontSize:13,fontWeight:FontWeight.w600))]),SizedBox(height:4),Text(desc,style:TextStyle(fontSize:11,color:Colors.grey[600])),SizedBox(height:6),SizedBox(width:200,child:ft.TextBox(controller:TextEditingController(text:value.toString()),onChanged:(x){final n=int.tryParse(x);if(n!=null)onChanged(n);}))]))));')
p.append('  Widget _choice(String flag,String name,String desc,String value,List<String> options,Function(String) onChanged)=>Padding(padding:EdgeInsets.only(bottom:10),child:SizedBox(width:380,child:ft.Card(padding:EdgeInsets.all(10),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Row(children:[Text(flag,style:TextStyle(fontSize:11,fontFamily:"monospace",color:Color(0xFF0078D4))),SizedBox(width:8),Text(name,style:TextStyle(fontSize:13,fontWeight:FontWeight.w600))]),SizedBox(height:4),Text(desc,style:TextStyle(fontSize:11,color:Colors.grey[600])),SizedBox(height:6),SizedBox(width:200,child:ft.ComboBox(value:value,items:options.map((o)=>ft.ComboBoxItem(value:o,child:Text(o))).toList(),onChanged:(x){if(x!=null)onChanged(x);}))]))));')
p.append('  Widget _bool(String flag,String name,String desc,bool value,Function(bool) onChanged)=>Padding(padding:EdgeInsets.only(bottom:10),child:SizedBox(width:380,child:ft.Card(padding:EdgeInsets.all(10),child:Column(crossAxisAlignment:CrossAxisAlignment.start,children:[Row(children:[Text(flag,style:TextStyle(fontSize:11,fontFamily:"monospace",color:Color(0xFF0078D4))),SizedBox(width:8),Text(name,style:TextStyle(fontSize:13,fontWeight:FontWeight.w600)),Spacer(),ft.ToggleSwitch(checked:value,onChanged:(v){onChanged(v);})]),Text(desc,style:TextStyle(fontSize:11,color:Colors.grey[600]))]))));')
p.append('  Widget _section(String t)=>Text(t,style:TextStyle(fontSize:14,fontWeight:FontWeight.w600));')

new_params = "\n".join(p)

pattern = r'  Widget _params\(\).*?(?=\n  Widget _profs)'
content = re.sub(pattern, new_params + "\n", content, flags=re.DOTALL)

# Remove old helpers
content = re.sub(r'\n  Widget _ip\(.*?\n  \}\);\n', '', content, flags=re.DOTALL)
content = re.sub(r'\n  Widget _dp\(.*?\n  \}\);\n', '', content, flags=re.DOTALL)
content = re.sub(r'\n  Widget _tp\(.*?\n  \}\);\n', '', content, flags=re.DOTALL)

with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\home_page.dart", "w", encoding="utf-8") as f:
    f.write(content)

print("OK - params updated")
