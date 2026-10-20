import fs from 'node:fs';
fs.mkdirSync('docs',{recursive:true});
for(const name of ['index.html','app.js','xlsx.js','query-chart.js','insights.json'])fs.copyFileSync('web/'+name,'docs/'+name);
fs.writeFileSync('docs/config.js',"window.NAVER_API_BASE='https://auto-search-pulse.yoonjintar0.chatgpt.site';\n");
fs.writeFileSync('docs/CNAME','keyword.jintar.co.kr\n');
