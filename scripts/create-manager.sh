#!/usr/bin/env bash
# Creates the Plant Manager's sign-in, once. Everyone else's sign-ins are made in the app.
#   sudo bash scripts/create-manager.sh
set -euo pipefail
cd "$(dirname "$0")/.."
read -rp "Plant Manager's full name: " NAME
read -rp "Username [plant.manager]: " USERNAME
USERNAME=${USERNAME:-plant.manager}
PASS="$(openssl rand -hex 3)-$(openssl rand -hex 3)-$(shuf -i 1000-9999 -n 1)"
docker compose exec -T db psql -v ON_ERROR_STOP=1 -q -U shiftbook_owner shiftbook \
  -v name="$NAME" -v username="$USERNAME" -v pass="$PASS" <<'SQL'
do $$ begin
  if exists (select 1 from staff where designation = 'plant_manager' and user_id is not null) then
    raise exception 'The Plant Manager already has a sign-in. Reset it from the app, or ask for help.';
  end if;
end $$;
update staff set user_id = auth.create_user(:'username', :'pass'), full_name = :'name'
where designation = 'plant_manager';
SQL
echo
echo "Sign in at $(grep ^APP_ORIGIN .env | cut -d= -f2-) with:"
echo "  Username: $USERNAME"
echo "  Temporary password: $PASS"
echo "You'll choose your own password straight away."
