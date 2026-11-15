# 마딱도란 일기 웹

Discord로 가입하고 일기를 쓰는 별도 웹 서비스입니다. 봇 v1.10의 SQLite 집계 로직을 재사용합니다. 첫 로그인에서 선택한 Discord 서버의 멤버인지 확인하며, 관리자가 사용자별 일기장을 열고 한국 또는 토론토 시간대를 설정합니다.

- 현지 오전 4시 정각까지 전날로 집계합니다. 하루 한 편을 저장하고 기존 글은 수정할 수 있습니다.
- 공백 및 숨은 제어문자를 제외한 본문 100자부터 출석과 골드를 인정합니다. 구간별 보상은 100자 50~100, 300자 100~150, 500자 150~200, 700자 200~250골드입니다. 1,000자 이상은 100 + 완성된 100자 묶음 × 20골드입니다. 수정 시 최초 난수를 유지하고 차액만 반영합니다.
- 최초 방패 2개를 지급합니다. 일기를 빠뜨린 날에는 1개씩 자동 소모합니다. 방패는 2,000골드이며 구매 후 보유량은 2개까지입니다. 10,000골드에 현재 연속 기록을 최고 기록으로 복구할 수 있습니다.
- 다른 사람의 유효한 글에 한 번씩 공감할 수 있습니다. 처음에는 10골드이며 누적 100/500/1,000/2,000회부터 다음 공감 보상이 각각 20/30/50/100골드입니다. 5,000회부터는 티켓도 1개 지급합니다.
- 완벽한 일기 주, 최초 연속 일기, 누적 글자 수, 누적 공감 마일스톤을 적용합니다. 보상과 축하 소식은 웹에 표시되며 티켓은 적립됩니다.
- 유효한 일기는 접속한 서버 회원에게 보입니다. 봇의 Discord 포럼과 웹 데이터베이스는 별개입니다.

## 배포

1. 이 저장소에서 HTTPS와 영구 디스크를 제공하는 서버로 컨테이너를 배포합니다. 컨테이너 포트는 `8000`, 영구 볼륨은 `/data`에 연결합니다. 호스트 디렉터리를 직접 연결하는 경우 컨테이너 사용자 UID 10001에 쓰기 권한을 주세요. 서버는 한 인스턴스로 실행합니다.
2. Discord Developer Portal에서 웹용 Application을 만들고 OAuth2 Redirects에 `https://서버-주소/auth/callback`을 등록합니다. 웹은 `identify`와 `guilds.members.read` 범위로 로그인합니다.
3. 서버 환경 변수에 `PUBLIC_ORIGIN=https://서버-주소`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID`, `DIARY_ADMIN_IDS`를 설정합니다. 관리자 ID가 여러 개면 쉼표로 구분합니다. Client Secret을 서버의 비밀 환경 변수에 저장하세요. 로그인용 애플리케이션은 봇 토큰을 사용하지 않습니다.
4. 서버의 `/healthz`에서 `discord_oauth`가 `true`인지 확인합니다. 실제 Discord 로그인 후 관리자 탭에서 첫 회원의 일기장을 열고 글을 저장해 보세요.
5. GitHub에서 Settings → Pages → Deploy from a branch → `main` → `/docs`를 선택합니다. `docs/config.js`에 서버의 공개 HTTPS 주소를 설정하면 Pages의 Discord 버튼이 서버의 OAuth 시작 주소로 연결됩니다.

GitHub Pages가 첫 화면을 제공하며, 로그인과 일기 화면은 HTTPS 서버에서 서비스합니다. 브라우저의 쿠키는 해당 서버에서만 사용합니다. 데이터와 백업은 배포 코드와 별도로 영구 볼륨을 통해 관리하세요.

## 로컬 실행

`python server.py`를 실행한 뒤 [localhost:8000](http://localhost:8000)을 엽니다. 로컬에서 OAuth를 연결할 경우 Developer Portal에 `http://localhost:8000/auth/callback`도 등록하세요. Python 3.11 이상과 시간대 데이터가 필요합니다. Windows에서는 `python -m pip install -r requirements.txt`로 함께 설치할 수 있습니다. 예제 파일의 값은 실제 실행 환경 변수에 넣습니다.

```shell
python -m unittest discover -s tests -v
node --check docs/app.js
```
