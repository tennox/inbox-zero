{
  # docs: https://devenv.sh/guides/using-with-flakes/#the-flakenix-file

  inputs = {
    nixpkgs.url = "github:cachix/devenv-nixpkgs/rolling"; # (i) https://devenv.sh/blog/2024/03/20/devenv-10-rewrite-in-rust/#testing-infrastructure
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    devenv.url = "github:cachix/devenv";
    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-parts.inputs.nixpkgs-lib.follows = "nixpkgs"; # (i) workaround until https://github.com/cachix/devenv/pull/2267
    systems.url = "github:nix-systems/default"; # (i) allows overriding systems easily, see https://github.com/nix-systems/nix-systems#consumer-usage
  };

  outputs = { self, nixpkgs, nixpkgs-unstable, devenv, systems, flake-parts, ... } @ inputs: (
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = (import systems);
      imports = [
        inputs.devenv.flakeModule
      ];
      # perSystem docs: https://flake.parts/module-arguments.html#persystem-module-parameters
      perSystem = { config, self', inputs', pkgs, system, ... }: {

        devenv.shells.default = {
          imports = [ ./devenv.nix ];
        };

      };
    }
  );

  nixConfig = {
    extra-substituters = [ "https://devenv.cachix.org" ];
    extra-trusted-public-keys = [ "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=" ];
  };
}
