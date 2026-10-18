// Interface text in English, Simplified Chinese, Traditional Chinese and Japanese. The choice is
// remembered in this browser (localStorage); the first visit follows the
// browser's language. Keys missing from a language fall back to English.

const STORE_KEY = 'softdrop-lang';

export const LANGS = [
  { code: 'en', label: 'English', html: 'en' },
  { code: 'zh', label: '简体中文', html: 'zh-Hans' },
  { code: 'zh-Hant', label: '繁體中文', html: 'zh-Hant' },
  { code: 'ja', label: '日本語', html: 'ja' },
];

const en = {
  'app.tagline': 'Files and text between your devices. Wi-Fi first.',
  'lang.aria': 'Language',
  'theme.aria': 'Theme: {mode}. Tap to change',
  'theme.system': 'System',
  'theme.light': 'Light',
  'theme.dark': 'Dark',

  'start.fail': 'Softdrop could not start here: {why}. Private browsing can block the storage it needs.',
  'start.noRtc': 'this browser has no WebRTC',
  'start.https': 'the page needs HTTPS',
  'replaced': 'Softdrop is open in another tab or window.',
  'useHere': 'Use it here',

  'nearby': 'Nearby',
  'radar.aria': 'Devices you can send to',
  'me': 'You',
  'radar.looking': 'Looking for devices nearby…',
  'radar.hint': 'Open this page on another device on the same Wi-Fi.',
  'status.waking': 'Waking up…',
  'status.notConnected': 'Not connected',
  'status.count': '{n} on this network',
  'status.countPaired': '{n} on this network · {m} paired elsewhere',
  'status.paused': 'Paused in this tab',
  'status.connecting': 'Connecting…',
  'status.reconnecting': 'Reconnecting…',
  'kind.paired': '{kind} · paired',
  'kind.relay': '{kind} · relay',
  'a11y.paired': 'paired',
  'badge.paired': 'Paired',
  'leftDevice': 'A device that left',

  'who.prefix': 'You appear to others as',
  'name.aria': 'Change your device name',
  'name.inputAria': 'Device name',
  'save': 'Save',

  'send.title': 'Send',
  'text.placeholder': 'Type or paste text, or drop files here',
  'pick': 'Choose files',
  'send': 'Send',
  'send.n': 'Send {n} items',
  'remove': 'Remove {name}',
  'to.label': 'To',
  'to.pick': 'Pick a device above to send to',
  'to.none': 'Waiting for a device to send to',
  'to.waitBack': 'Waiting for {name} to come back, or pick another device',
  'connecting': 'Connecting…',

  'route.lan': 'Direct · same Wi-Fi',
  'route.direct': 'Direct',
  'route.relay': 'Via relay',
  'route.pendingPaired': 'Paired · elsewhere',
  'route.pendingLan': 'Same network',

  'pair.aria': 'Pair a device on another network',
  'pair.title': 'Different network?',
  'pair.sub': 'Pair once with a 4-digit code. Paired devices find each other anywhere.',
  'pair.getCode': 'Get a code',
  'pair.newCode': 'New code',
  'pair.inputAria': 'Pairing code from the other device',
  'pair.btn': 'Pair',
  'pair.listAria': 'Paired devices',
  'pair.yourCode': 'Your code {code} · {time}. Enter it on the other device.',
  'pair.notReady': 'Not connected yet. One moment…',
  'pair.pairing': 'Pairing…',
  'pair.badSecurity': 'Pairing failed a security check.',
  'pair.done': 'Paired with {name}. It will show up here whenever both of you are online.',
  'pair.forgot': 'Forgot {name}.',
  'pair.forget': 'Forget {name}',
  'pair.forgetTitle': 'Forget',
  'err.bad-code': 'That code did not work. Check it, or ask for a new one.',
  'err.own-code': 'That is your own code. Enter the code shown on the other device.',
  'err.rate-limited': 'Too many tries. Wait a few minutes.',


  'act.title': 'Activity',
  'list.empty': 'Nothing yet. Pick a device and send something.',
  'item.text': 'Text message',
  'item.from': 'From {who} · {size}',
  'item.to': 'To {who} · {size}',
  'item.wants': 'Wants to send you · {size} from {who}',
  'accept': 'Accept',
  'decline': 'Decline',
  'cancel': 'Cancel',
  'progress.aria': 'Transfer progress',
  'trust.yes': 'Paired device',
  'trust.no': 'Not paired',
  'st.waitingAccept': 'Waiting for them to accept…',
  'st.pausedOut': 'Paused · will retry when they are back',
  'st.pausedIn': 'Paused · waiting for the sender',
  'st.checking': 'Checking…',
  'st.received': 'Received',
  'st.sent': 'Sent',
  'st.declined': 'Declined',
  'st.canceled': 'Canceled',
  'st.failed': 'Didn’t finish',
  'copy': 'Copy',
  'copied': 'Copied',
  'copyFail': 'Select the text',
  'share': 'Share',

  'err.unreach': 'Could not reach the device',
  'err.lost': 'Connection lost',
  'err.setup': 'Connection setup failed',
  'err.cert': 'Security check failed: unexpected certificate',
  'err.connect': 'Could not connect',
  'err.waitConn': 'Waiting for the connection…',
  'err.order': 'Data arrived out of order',
  'err.save': 'Could not save the file',
  'err.early': 'Transfer ended early',
  'err.hash': 'Check failed: the file was damaged',
  'err.remote': 'The other device reported a problem',
  'err.left': 'The sender left',

  'install.ios': 'Keep Softdrop on your Home Screen: tap Share, then “Add to Home Screen”.',
  'install.app': 'Install Softdrop as an app for quicker sending.',
  'install.btn': 'Install',
  'install.later': 'Not now',

  'foot.e2e': 'End-to-end encrypted. The server only introduces your devices and never sees what you send.',
  'foot.key': 'Your key',
  'debug.title': 'Debug log',
  'debug.note': 'Also sent to the server log. Turn off with ?debug=0',
  'debug.copy': 'Copy',
  'debug.clear': 'Clear',
  'debug.hide': 'Hide',
  'debug.show': 'Show',
  'hint.vpn': 'This transfer is slow because a VPN is sending it the long way round. Turn off the VPN on your phone while you send, and it will go at full Wi-Fi speed.',
};

const zh = {
  'app.tagline': '在你的设备之间传送文件和文字，优先走 Wi-Fi。',
  'lang.aria': '语言',
  'theme.aria': '主题：{mode}。点按切换',
  'theme.system': '跟随系统',
  'theme.light': '浅色',
  'theme.dark': '深色',

  'start.fail': 'Softdrop 无法在这里启动：{why}。无痕浏览可能会阻止它所需的存储。',
  'start.noRtc': '此浏览器不支持 WebRTC',
  'start.https': '此页面需要 HTTPS',
  'replaced': 'Softdrop 已在另一个标签页或窗口中打开。',
  'useHere': '在这里使用',

  'nearby': '附近',
  'radar.aria': '可以发送的设备',
  'me': '你',
  'radar.looking': '正在寻找附近的设备…',
  'radar.hint': '在同一 Wi-Fi 下的另一台设备上打开这个页面。',
  'status.waking': '正在启动…',
  'status.notConnected': '未连接',
  'status.count': '此网络中有 {n} 台',
  'status.countPaired': '此网络中有 {n} 台 · 其他网络已配对 {m} 台',
  'status.paused': '此标签页已暂停',
  'status.connecting': '正在连接…',
  'status.reconnecting': '正在重新连接…',
  'kind.paired': '{kind} · 已配对',
  'kind.relay': '{kind} · 中继',
  'a11y.paired': '已配对',
  'badge.paired': '已配对',
  'leftDevice': '已离开的设备',

  'who.prefix': '别人看到的你是',
  'name.aria': '修改设备名称',
  'name.inputAria': '设备名称',
  'save': '保存',

  'send.title': '发送',
  'text.placeholder': '输入或粘贴文字，或把文件拖到这里',
  'pick': '选择文件',
  'send': '发送',
  'send.n': '发送 {n} 项',
  'remove': '移除 {name}',
  'to.label': '发送到',
  'to.pick': '在上方选择要发送的设备',
  'to.none': '正在等待可以发送的设备',
  'to.waitBack': '正在等 {name} 回来，也可以选择其他设备',
  'connecting': '正在连接…',

  'route.lan': '直连 · 同一 Wi-Fi',
  'route.direct': '直连',
  'route.relay': '经由中继',
  'route.pendingPaired': '已配对 · 其他网络',
  'route.pendingLan': '同一网络',

  'pair.aria': '配对其他网络中的设备',
  'pair.title': '不在同一个网络？',
  'pair.sub': '用 4 位数字配对一次，之后在任何网络都能找到彼此。',
  'pair.getCode': '获取配对码',
  'pair.newCode': '换一个配对码',
  'pair.inputAria': '另一台设备上的配对码',
  'pair.btn': '配对',
  'pair.listAria': '已配对的设备',
  'pair.yourCode': '你的配对码 {code} · {time}，请在另一台设备上输入。',
  'pair.notReady': '还没连上，请稍等…',
  'pair.pairing': '正在配对…',
  'pair.badSecurity': '配对未通过安全检查。',
  'pair.done': '已与 {name} 配对。只要双方都在线，它就会出现在这里。',
  'pair.forgot': '已移除 {name}。',
  'pair.forget': '移除 {name}',
  'pair.forgetTitle': '移除',
  'err.bad-code': '这个配对码无效。请检查一下，或者换一个新的。',
  'err.own-code': '这是你自己的配对码。请输入另一台设备上显示的配对码。',
  'err.rate-limited': '尝试次数太多，请过几分钟再试。',


  'act.title': '动态',
  'list.empty': '还没有内容。选择一台设备，发点什么吧。',
  'item.text': '文字消息',
  'item.from': '来自 {who} · {size}',
  'item.to': '发给 {who} · {size}',
  'item.wants': '{who} 想发给你 · {size}',
  'accept': '接收',
  'decline': '拒绝',
  'cancel': '取消',
  'progress.aria': '传输进度',
  'trust.yes': '已配对的设备',
  'trust.no': '未配对',
  'st.waitingAccept': '等待对方接收…',
  'st.pausedOut': '已暂停 · 对方回来后会继续',
  'st.pausedIn': '已暂停 · 等待发送方',
  'st.checking': '正在校验…',
  'st.received': '已接收',
  'st.sent': '已发送',
  'st.declined': '已拒绝',
  'st.canceled': '已取消',
  'st.failed': '未完成',
  'copy': '复制',
  'copied': '已复制',
  'copyFail': '请手动选择文字',
  'share': '分享',

  'err.unreach': '无法连接到这台设备',
  'err.lost': '连接已断开',
  'err.setup': '建立连接失败',
  'err.cert': '安全检查失败：证书不符',
  'err.connect': '无法连接',
  'err.waitConn': '正在等待连接…',
  'err.order': '数据顺序错乱',
  'err.save': '无法保存文件',
  'err.early': '传输提前结束',
  'err.hash': '校验失败：文件已损坏',
  'err.remote': '对方设备出了问题',
  'err.left': '发送方已离开',

  'install.ios': '把 Softdrop 放到主屏幕：点按“分享”，再选“添加到主屏幕”。',
  'install.app': '把 Softdrop 安装成应用，发送更方便。',
  'install.btn': '安装',
  'install.later': '以后再说',

  'foot.e2e': '端到端加密。服务器只负责让你的设备互相认识，永远看不到你发送的内容。',
  'foot.key': '你的密钥',
  'debug.title': '调试日志',
  'debug.note': '同时会发送到服务器日志。用 ?debug=0 关闭',
  'debug.copy': '复制',
  'debug.clear': '清空',
  'debug.hide': '收起',
  'debug.show': '展开',
  'hint.vpn': '传输较慢，因为 VPN 让数据绕了远路。发送时暂时关闭手机上的 VPN，就能以 Wi-Fi 全速传输。',
};

const zhHant = {
  'app.tagline': '在你的裝置之間傳送檔案和文字，優先走 Wi-Fi。',
  'lang.aria': '語言',
  'theme.aria': '主題：{mode}。點按切換',
  'theme.system': '跟隨系統',
  'theme.light': '淺色',
  'theme.dark': '深色',

  'start.fail': 'Softdrop 無法在這裡啟動：{why}。無痕瀏覽可能會阻擋它需要的儲存空間。',
  'start.noRtc': '這個瀏覽器不支援 WebRTC',
  'start.https': '這個頁面需要 HTTPS',
  'replaced': 'Softdrop 已在另一個分頁或視窗中開啟。',
  'useHere': '在這裡使用',

  'nearby': '附近',
  'radar.aria': '可以傳送的裝置',
  'me': '你',
  'radar.looking': '正在尋找附近的裝置…',
  'radar.hint': '在同一個 Wi-Fi 的另一台裝置上開啟這個頁面。',
  'status.waking': '正在啟動…',
  'status.notConnected': '未連線',
  'status.count': '這個網路中有 {n} 台',
  'status.countPaired': '這個網路中有 {n} 台 · 其他網路已配對 {m} 台',
  'status.paused': '這個分頁已暫停',
  'status.connecting': '正在連線…',
  'status.reconnecting': '正在重新連線…',
  'kind.paired': '{kind} · 已配對',
  'kind.relay': '{kind} · 中繼',
  'a11y.paired': '已配對',
  'badge.paired': '已配對',
  'leftDevice': '已離開的裝置',

  'who.prefix': '別人看到的你是',
  'name.aria': '修改裝置名稱',
  'name.inputAria': '裝置名稱',
  'save': '儲存',

  'send.title': '傳送',
  'text.placeholder': '輸入或貼上文字，或把檔案拖到這裡',
  'pick': '選擇檔案',
  'send': '傳送',
  'send.n': '傳送 {n} 項',
  'remove': '移除 {name}',
  'to.label': '傳送到',
  'to.pick': '在上方選擇要傳送的裝置',
  'to.none': '正在等待可以傳送的裝置',
  'to.waitBack': '正在等 {name} 回來，也可以選擇其他裝置',
  'connecting': '正在連線…',

  'route.lan': '直連 · 同一個 Wi-Fi',
  'route.direct': '直連',
  'route.relay': '經由中繼',
  'route.pendingPaired': '已配對 · 其他網路',
  'route.pendingLan': '同一個網路',

  'pair.aria': '配對其他網路中的裝置',
  'pair.title': '不在同一個網路？',
  'pair.sub': '用 4 位數字配對一次，之後在任何網路都能找到彼此。',
  'pair.getCode': '取得配對碼',
  'pair.newCode': '換一組配對碼',
  'pair.inputAria': '另一台裝置上的配對碼',
  'pair.btn': '配對',
  'pair.listAria': '已配對的裝置',
  'pair.yourCode': '你的配對碼 {code} · {time}，請在另一台裝置上輸入。',
  'pair.notReady': '還沒連上，請稍候…',
  'pair.pairing': '正在配對…',
  'pair.badSecurity': '配對未通過安全檢查。',
  'pair.done': '已與 {name} 配對。只要雙方都在線上，它就會出現在這裡。',
  'pair.forgot': '已移除 {name}。',
  'pair.forget': '移除 {name}',
  'pair.forgetTitle': '移除',
  'err.bad-code': '這組配對碼無效。請檢查一下，或換一組新的。',
  'err.own-code': '這是你自己的配對碼。請輸入另一台裝置上顯示的配對碼。',
  'err.rate-limited': '嘗試次數太多，請過幾分鐘再試。',


  'act.title': '動態',
  'list.empty': '還沒有內容。選擇一台裝置，傳點什麼吧。',
  'item.text': '文字訊息',
  'item.from': '來自 {who} · {size}',
  'item.to': '傳給 {who} · {size}',
  'item.wants': '{who} 想傳給你 · {size}',
  'accept': '接收',
  'decline': '拒絕',
  'cancel': '取消',
  'progress.aria': '傳輸進度',
  'trust.yes': '已配對的裝置',
  'trust.no': '未配對',
  'st.waitingAccept': '等待對方接收…',
  'st.pausedOut': '已暫停 · 對方回來後會繼續',
  'st.pausedIn': '已暫停 · 等待傳送方',
  'st.checking': '正在驗證…',
  'st.received': '已接收',
  'st.sent': '已傳送',
  'st.declined': '已拒絕',
  'st.canceled': '已取消',
  'st.failed': '未完成',
  'copy': '複製',
  'copied': '已複製',
  'copyFail': '請手動選取文字',
  'share': '分享',

  'err.unreach': '無法連線到這台裝置',
  'err.lost': '連線已中斷',
  'err.setup': '建立連線失敗',
  'err.cert': '安全檢查失敗：憑證不符',
  'err.connect': '無法連線',
  'err.waitConn': '正在等待連線…',
  'err.order': '資料順序錯亂',
  'err.save': '無法儲存檔案',
  'err.early': '傳輸提前結束',
  'err.hash': '驗證失敗：檔案已損壞',
  'err.remote': '對方裝置發生問題',
  'err.left': '傳送方已離開',

  'install.ios': '把 Softdrop 加到主畫面：點按「分享」，再選「加入主畫面」。',
  'install.app': '把 Softdrop 安裝成 App，傳送更方便。',
  'install.btn': '安裝',
  'install.later': '以後再說',

  'foot.e2e': '端對端加密。伺服器只負責讓你的裝置互相認識，永遠看不到你傳送的內容。',
  'foot.key': '你的金鑰',
  'debug.title': '除錯日誌',
  'debug.note': '同時會傳送到伺服器日誌。用 ?debug=0 關閉',
  'debug.copy': '複製',
  'debug.clear': '清除',
  'debug.hide': '收起',
  'debug.show': '展開',
  'hint.vpn': '傳輸較慢，因為 VPN 讓資料繞了遠路。傳送時暫時關閉手機上的 VPN，就能以 Wi-Fi 全速傳輸。',
};

const ja = {
  'app.tagline': 'デバイス間でファイルとテキストを。Wi-Fi を優先して。',
  'lang.aria': '言語',
  'theme.aria': 'テーマ：{mode}。タップで切り替え',
  'theme.system': 'システム',
  'theme.light': 'ライト',
  'theme.dark': 'ダーク',

  'start.fail': 'Softdrop をここで起動できませんでした：{why}。プライベートブラウズでは必要なストレージが使えないことがあります。',
  'start.noRtc': 'このブラウザは WebRTC に対応していません',
  'start.https': 'このページには HTTPS が必要です',
  'replaced': 'Softdrop は別のタブかウィンドウで開かれています。',
  'useHere': 'ここで使う',

  'nearby': '近くのデバイス',
  'radar.aria': '送信できるデバイス',
  'me': 'あなた',
  'radar.looking': '近くのデバイスを探しています…',
  'radar.hint': '同じ Wi-Fi の別のデバイスでこのページを開いてください。',
  'status.waking': '起動中…',
  'status.notConnected': '未接続',
  'status.count': 'このネットワークに {n} 台',
  'status.countPaired': 'このネットワークに {n} 台 · 別の場所にペア済み {m} 台',
  'status.paused': 'このタブでは一時停止中',
  'status.connecting': '接続中…',
  'status.reconnecting': '再接続中…',
  'kind.paired': '{kind} · ペア済み',
  'kind.relay': '{kind} · リレー',
  'a11y.paired': 'ペアリング済み',
  'badge.paired': 'ペアリング済み',
  'leftDevice': '退出したデバイス',

  'who.prefix': 'ほかのデバイスでの表示名',
  'name.aria': 'デバイス名を変更',
  'name.inputAria': 'デバイス名',
  'save': '保存',

  'send.title': '送る',
  'text.placeholder': 'テキストを入力・貼り付け、またはファイルをここにドロップ',
  'pick': 'ファイルを選ぶ',
  'send': '送信',
  'send.n': '{n} 件を送信',
  'remove': '{name} を外す',
  'to.label': '送り先',
  'to.pick': '上のデバイスから送り先を選んでください',
  'to.none': '送り先のデバイスを待っています',
  'to.waitBack': '{name} が戻るのを待っています。別のデバイスも選べます',
  'connecting': '接続中…',

  'route.lan': '直接 · 同じ Wi-Fi',
  'route.direct': '直接',
  'route.relay': 'リレー経由',
  'route.pendingPaired': 'ペア済み · 別の場所',
  'route.pendingLan': '同じネットワーク',

  'pair.aria': '別のネットワークのデバイスとペアリング',
  'pair.title': '別のネットワーク？',
  'pair.sub': '4 桁のコードで一度ペアリングすれば、どこにいても見つけ合えます。',
  'pair.getCode': 'コードを表示',
  'pair.newCode': '新しいコード',
  'pair.inputAria': '相手のデバイスのペアリングコード',
  'pair.btn': 'ペアリング',
  'pair.listAria': 'ペアリング済みのデバイス',
  'pair.yourCode': 'あなたのコード {code} · {time}。相手のデバイスで入力してください。',
  'pair.notReady': 'まだ接続していません。少々お待ちください…',
  'pair.pairing': 'ペアリング中…',
  'pair.badSecurity': 'ペアリングが安全確認に失敗しました。',
  'pair.done': '{name} とペアリングしました。お互いがオンラインのとき、ここに表示されます。',
  'pair.forgot': '{name} を削除しました。',
  'pair.forget': '{name} を削除',
  'pair.forgetTitle': '削除',
  'err.bad-code': 'このコードは使えませんでした。確認するか、新しいコードを表示してもらってください。',
  'err.own-code': 'これはあなた自身のコードです。相手のデバイスに表示されたコードを入力してください。',
  'err.rate-limited': '試行回数が多すぎます。数分待ってからお試しください。',


  'act.title': 'アクティビティ',
  'list.empty': 'まだ何もありません。デバイスを選んで送ってみましょう。',
  'item.text': 'テキスト',
  'item.from': '{who} から · {size}',
  'item.to': '{who} へ · {size}',
  'item.wants': '{who} から届いています · {size}',
  'accept': '受け取る',
  'decline': '断る',
  'cancel': 'キャンセル',
  'progress.aria': '転送の進み具合',
  'trust.yes': 'ペアリング済みのデバイス',
  'trust.no': '未ペアリング',
  'st.waitingAccept': '相手の承認を待っています…',
  'st.pausedOut': '一時停止 · 相手が戻ったら再開します',
  'st.pausedIn': '一時停止 · 送信元を待っています',
  'st.checking': '確認中…',
  'st.received': '受信しました',
  'st.sent': '送信しました',
  'st.declined': '断られました',
  'st.canceled': 'キャンセルしました',
  'st.failed': '完了しませんでした',
  'copy': 'コピー',
  'copied': 'コピーしました',
  'copyFail': 'テキストを選択してください',
  'share': '共有',

  'err.unreach': 'デバイスに接続できませんでした',
  'err.lost': '接続が切れました',
  'err.setup': '接続の準備に失敗しました',
  'err.cert': '安全確認に失敗しました：証明書が一致しません',
  'err.connect': '接続できませんでした',
  'err.waitConn': '接続を待っています…',
  'err.order': 'データの順序が乱れました',
  'err.save': 'ファイルを保存できませんでした',
  'err.early': '転送が途中で終わりました',
  'err.hash': '確認に失敗しました：ファイルが壊れています',
  'err.remote': '相手のデバイスで問題が起きました',
  'err.left': '送信元がいなくなりました',

  'install.ios': 'Softdrop をホーム画面に：共有ボタンから「ホーム画面に追加」をタップ。',
  'install.app': 'Softdrop をアプリとしてインストールすると、すぐに送れます。',
  'install.btn': 'インストール',
  'install.later': '今はしない',

  'foot.e2e': 'エンドツーエンドで暗号化。サーバーはデバイス同士を引き合わせるだけで、送った内容を見ることはありません。',
  'foot.key': 'あなたの鍵',
  'debug.title': 'デバッグログ',
  'debug.note': 'サーバーのログにも送信されます。?debug=0 でオフ',
  'debug.copy': 'コピー',
  'debug.clear': '消去',
  'debug.hide': '隠す',
  'debug.show': '表示',
  'hint.vpn': 'VPN がデータを遠回りさせているため、転送が遅くなっています。送信中だけスマホの VPN をオフにすると、Wi-Fi の速度で送れます。',
};

const DICT = { en, zh, 'zh-Hant': zhHant, ja };

function detect() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved && DICT[saved]) return saved;
  } catch {}
  for (const l of navigator.languages || [navigator.language || 'en']) {
    const x = String(l).toLowerCase();
    if (/^zh-(hant|tw|hk|mo)/.test(x)) return 'zh-Hant';
    if (x.startsWith('zh')) return 'zh';
    if (x.startsWith('ja')) return 'ja';
    if (x.startsWith('en')) return 'en';
  }
  return 'en';
}

let lang = detect();
const listeners = new Set();

export function getLang() {
  return lang;
}

export function setLang(code) {
  if (!DICT[code] || code === lang) return;
  lang = code;
  try { localStorage.setItem(STORE_KEY, code); } catch {}
  applyStatic();
  listeners.forEach((fn) => fn(lang));
}

export function onLangChange(fn) {
  listeners.add(fn);
}

/** Plain-text translation with {var} substitution. */
export function t(key, vars) {
  let s = (DICT[lang] && DICT[lang][key]) ?? en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

/** Like t(), but for innerHTML: the template is trusted, variables must already be safe HTML. */
export const th = t;

/** Translate a stored error/reason: a key when we know it, else the text as it came. */
export function tr(s) {
  if (!s) return '';
  return en[s] ? t(s) : s;
}

/**
 * Fill static markup: data-i18n="key" sets textContent,
 * data-i18n-attr="attr:key;attr2:key2" sets attributes.
 */
export function applyStatic(root = document) {
  const meta = LANGS.find((l) => l.code === lang);
  document.documentElement.lang = meta ? meta.html : lang;
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':');
      if (attr && key) el.setAttribute(attr.trim(), t(key.trim()));
    }
  });
}
