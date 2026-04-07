init:
    chezmoi --config ~/.config/chezmoi-piconfig/chezmoi.yaml init

apply:
    chezmoi --config ~/.config/chezmoi-piconfig/chezmoi.yaml apply

diff:
    chezmoi --config ~/.config/chezmoi-piconfig/chezmoi.yaml diff

# Generate honcho .env file for the current environment
honcho-env:
    @echo "Generating honcho/.env for current environment..."
    @env_name=$(chezmoi --config ~/.config/chezmoi-piconfig/chezmoi.yaml data | jq -r '.environment'); \
    env_file=$(if [ "$env_name" = "work" ]; then echo .chezmoitemplates/honcho/env.work; else echo .chezmoitemplates/honcho/env.home; fi); \
    chezmoi --config ~/.config/chezmoi-piconfig/chezmoi.yaml execute-template < .chezmoitemplates/honcho/env.base > honcho/.env; \
    printf '\n' >> honcho/.env; \
    chezmoi --config ~/.config/chezmoi-piconfig/chezmoi.yaml execute-template < "$env_file" >> honcho/.env
    @echo "✓ honcho/.env generated"
