# PS Log — 코딩테스트 복습 기록

푼 문제를 기록하고, 틀린 문제는 3·7·21일 뒤에 다시 보도록 일정을 잡아 주는 개인용 웹 앱입니다. 문제 기록, 월별 잔디, C++/Java/Python 개념 노트, 주간 일정표, GitHub 동기화와 복습 메일을 제공합니다.

이 저장소에는 실행 코드만 있습니다. 실제 기록은 각 사용자가 만든 별도의 Private GitHub 저장소의 `data.json`에 저장됩니다.

## 구조

```text
Public 코드 저장소 (이 저장소 또는 Fork)
  ├─ public/            브라우저 앱
  ├─ worker/            복습 메일 Worker
  └─ wrangler.jsonc     Cloudflare 배포 설정

Private 데이터 저장소 (사용자별로 별도 생성)
  └─ data.json          문제·개념·일정·이미지 기록
```

- 프런트엔드: 순수 HTML/CSS/JavaScript
- 호스팅 및 cron: Cloudflare Workers + Static Assets
- 데이터 저장: GitHub Contents API
- 메일 발송: Resend HTTP API
- 빌드 과정 없음

## 1. 코드 Fork

GitHub에서 이 저장소를 Fork합니다. Fork는 코드와 배포 설정만 담으며 개인 기록을 커밋하지 않습니다.

```bash
git clone https://github.com/<내계정>/ps-log.git
cd ps-log
npm install
```

## 2. Private 데이터 저장소 만들기

GitHub에서 `ps-log-data` 같은 이름의 **Private** 저장소를 만들고 기본 브랜치를 `master`로 설정합니다. `data.example.json`을 복사해 `data.json`으로 만들고 데이터 저장소에만 커밋합니다.

```bash
cp data.example.json data.json
```

Private 데이터 저장소의 결과는 다음처럼 단순합니다.

```text
ps-log-data/
└─ data.json
```

> `data.json`을 이 Public 코드 저장소나 Public Fork에 커밋하지 마세요. `.gitignore`에서 차단하고 있습니다.

## 3. GitHub 토큰 만들기

GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens에서 Private 데이터 저장소 하나만 선택합니다.

### 브라우저용 토큰

- Repository access: Only select repositories → `ps-log-data`
- Repository permissions → Contents: **Read and write**

앱이 `data.json`을 읽고 자동 커밋할 때 사용합니다. 토큰은 해당 브라우저의 localStorage에만 저장됩니다.

### Worker용 토큰

- Repository access: Only select repositories → `ps-log-data`
- Repository permissions → Contents: **Read-only**

자동 복습 메일이 `data.json`을 읽을 때만 사용합니다.

## 4. Cloudflare 설정

`wrangler.jsonc`에서 아래 값을 본인의 Private 데이터 저장소에 맞춥니다.

```jsonc
"vars": {
  "GITHUB_REPO": "<내계정>/ps-log-data",
  "GITHUB_BRANCH": "master",
  "GITHUB_PATH": "data.json"
}
```

배포합니다.

```bash
npx wrangler login
npx wrangler deploy
```

메일 자동 발송을 사용한다면 Worker 시크릿을 등록합니다.

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_TO
npx wrangler secret put CRON_KEY
```

선택적으로 인증한 발신 도메인이 있다면 다음도 등록합니다.

```bash
npx wrangler secret put MAIL_FROM
```

## 5. 앱에서 데이터 저장소 연결

배포된 사이트에서 **설정**을 열고 다음 값을 입력합니다.

| 항목 | 값 |
|---|---|
| 저장소 | `<내계정>/ps-log-data` |
| 액세스 토큰 | 브라우저용 Read and write 토큰 |
| 브랜치 | `master` |
| 파일 경로 | `data.json` |
| 받는 주소 | 복습 메일을 받을 주소 |

연결 테스트 후 저장합니다. 다른 기기에서도 각각 한 번씩 설정해야 합니다.

## 6. 메일 테스트

```bash
curl "https://ps-log.<Cloudflare계정>.workers.dev/__cron?key=<CRON_KEY>&test=1"
```

- `테스트 메일을 발송했습니다.`: 정상
- `Forbidden`: `CRON_KEY` 확인
- `GitHub 404`: 저장소·브랜치·토큰 접근 범위 확인
- `Resend 403`: 무료 계정의 수신 주소 제한 확인

cron은 기본적으로 매일 UTC 23:00, 한국 시각 오전 8시에 실행됩니다.

## 로컬 실행

```bash
npm run dev
```

화면만 확인하려면 다음 명령도 사용할 수 있습니다.

```bash
python -m http.server 8000 --directory public
```

## 데이터와 보안

- Public 저장소에는 개인 `data.json`을 두지 않습니다.
- 브라우저용 토큰은 Private 데이터 저장소 하나에만 Read and write 권한을 줍니다.
- Worker용 토큰은 같은 저장소에 Read-only 권한만 줍니다.
- `.dev.vars`, 토큰, Resend 키는 Git에 커밋하지 않습니다.
- Public 저장소를 만들 때 개인 데이터가 있던 저장소의 Git 기록을 복사하지 마세요.
- 기록을 바꾸면 앱이 약 4초 후 Private 데이터 저장소에 자동 커밋합니다.

## 주요 기능

- 문제 번호·제목·사이트·난이도·결과 기록
- 실패 문제 3일·7일·21일 복습 일정
- 월별 문제/복습 잔디
- C++·Java·Python별 Markdown 개념 노트와 이미지
- 주간 일정표
- 여러 기기 간 GitHub 동기화와 충돌 처리
- JSON 내보내기/불러오기
- Resend를 이용한 자동 복습 메일
